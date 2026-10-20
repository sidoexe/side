//! Logins of the embedded web apps, kept alive on sIDE's side.
//!
//! A login is cookies in the app's WebKit store, and a store loses them:
//! session cookies (no expiry) die with the app, and a store can be cleared
//! or reset. Two defences:
//!
//! - cookies a site meant for one browsing session get a lifetime, so the
//!   store keeps them across launches;
//! - a snapshot of every app's cookies sits in the system credential store,
//!   and whatever a store is missing when its app opens is put back.
//!
//! The snapshot follows the store, it never fights the site: a cookie the site
//! removed, or let expire, is gone from the next snapshot too.
//!
//! Cookies are read and written through WebKit itself, not through Tauri's
//! `Cookie`: that type drops the dot of `.example.com`, and a cookie written
//! back without it no longer reaches the subdomains (or sits next to the
//! original as a duplicate). Only macOS is covered for now; elsewhere the
//! stores are left to themselves.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// How long a login the site only meant for one browsing session is kept.
const SESSION_LIFETIME_SECS: i64 = 90 * 24 * 3600;

#[cfg(any(target_os = "macos", target_os = "linux"))]
const SERVICE: &str = "dev.sidoexe.side.web-apps";

/// A cookie as the store holds it, domain verbatim.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
struct SavedCookie {
    name: String,
    value: String,
    /// With its leading dot when the cookie reaches subdomains.
    domain: String,
    path: String,
    secure: bool,
    http_only: bool,
    /// "lax" or "strict"; anything else is left unset, as WebKit does.
    same_site: Option<String>,
    /// Unix seconds; None for a cookie that dies with the browsing session.
    expires: Option<i64>,
}

impl SavedCookie {
    fn is_live(&self, now: i64) -> bool {
        self.expires.is_some_and(|at| at > now)
    }

    /// What makes a cookie the same one for the store.
    fn key(&self) -> (&str, &str, &str) {
        (&self.name, &self.domain, &self.path)
    }
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// Give the session cookies a lifetime; the ones that got it.
fn make_persistent(cookies: &mut [SavedCookie], now: i64) -> Vec<SavedCookie> {
    cookies
        .iter_mut()
        .filter(|cookie| cookie.expires.is_none())
        .map(|cookie| {
            cookie.expires = Some(now + SESSION_LIFETIME_SECS);
            cookie.clone()
        })
        .collect()
}

/// The lasting cookies of `current`: what is worth coming back.
fn snapshot_of(current: &[SavedCookie], now: i64) -> Vec<SavedCookie> {
    current
        .iter()
        .filter(|cookie| cookie.is_live(now))
        .cloned()
        .collect()
}

/// What the snapshot has that the store lacks. What the store has is at
/// least as new as the snapshot, and stays.
fn missing(saved: &[SavedCookie], current: &[SavedCookie], now: i64) -> Vec<SavedCookie> {
    let present: HashSet<_> = current.iter().map(SavedCookie::key).collect();
    saved
        .iter()
        .filter(|cookie| cookie.is_live(now) && !present.contains(&cookie.key()))
        .cloned()
        .collect()
}

/// The cookies a store had when it was last kept.
pub struct Snapshot(Vec<SavedCookie>);

impl Snapshot {
    /// Put back what `webview`'s store lost since.
    pub fn restore(&self, webview: &tauri::Webview) {
        // Can't tell what is missing: better no restore than an old one over a new login.
        let Ok(current) = store::read_all(webview) else {
            return;
        };
        let lost = missing(&self.0, &current, now());
        if !lost.is_empty() {
            let _ = store::write_all(webview, lost);
        }
    }
}

/// What `store` had when it was last kept; None when nothing is waiting.
pub fn snapshot(store: uuid::Uuid) -> Option<Snapshot> {
    let saved: Vec<SavedCookie> = serde_json::from_str(&read(store)?).ok()?;
    (!saved.is_empty()).then_some(Snapshot(saved))
}

/// Make `webview`'s session cookies lasting and keep a snapshot of its
/// cookies. The webview must be open on `store`.
pub fn keep(webview: &tauri::Webview, store: uuid::Uuid) -> Result<(), String> {
    let mut cookies = store::read_all(webview)?;
    let now = now();
    let lasting = make_persistent(&mut cookies, now);
    if !lasting.is_empty() {
        // Best-effort: the snapshot below has them either way.
        let _ = store::write_all(webview, lasting);
    }
    save(store, &snapshot_of(&cookies, now));
    Ok(())
}

/// Sign `store` out of the snapshot too.
pub fn forget(store: uuid::Uuid) {
    if let Ok(mut written) = written().lock() {
        written.remove(&store);
    }
    delete(store);
}

/// What was last written per store, so an unchanged login doesn't touch the
/// credential store every few seconds.
fn written() -> &'static Mutex<HashMap<uuid::Uuid, String>> {
    static WRITTEN: OnceLock<Mutex<HashMap<uuid::Uuid, String>>> = OnceLock::new();
    WRITTEN.get_or_init(Default::default)
}

fn save(store: uuid::Uuid, saved: &[SavedCookie]) {
    // An empty snapshot is a sign-out: it must not outlive it.
    let text = if saved.is_empty() {
        String::new()
    } else {
        match serde_json::to_string(saved) {
            Ok(text) => text,
            Err(_) => return,
        }
    };
    let Ok(mut written) = written().lock() else {
        return;
    };
    if written.get(&store) == Some(&text) {
        return;
    }
    let done = if text.is_empty() {
        delete(store);
        true
    } else {
        write(store, &text).is_ok()
    };
    if done {
        written.insert(store, text);
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn entry(store: uuid::Uuid) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, &store.simple().to_string()).map_err(|e| e.to_string())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn read(store: uuid::Uuid) -> Option<String> {
    entry(store).ok()?.get_password().ok()
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn write(store: uuid::Uuid, text: &str) -> Result<(), String> {
    entry(store)?.set_password(text).map_err(|e| e.to_string())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn delete(store: uuid::Uuid) {
    if let Ok(entry) = entry(store) {
        let _ = entry.delete_credential();
    }
}

// No system credential store to keep a login in: the stores alone remain.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn read(_: uuid::Uuid) -> Option<String> {
    None
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn write(_: uuid::Uuid, _: &str) -> Result<(), String> {
    Err("no credential store".into())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn delete(_: uuid::Uuid) {}

/// WebKit's cookie store: the one place that knows a cookie's real domain.
#[cfg(target_os = "macos")]
mod store {
    use std::ptr::NonNull;
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{
        ns_string, NSArray, NSDate, NSHTTPCookie, NSHTTPCookieDomain, NSHTTPCookieExpires,
        NSHTTPCookieName, NSHTTPCookiePath, NSHTTPCookieSecure, NSHTTPCookieValue,
        NSHTTPCookieVersion, NSMutableDictionary, NSString,
    };
    use objc2_web_kit::{WKHTTPCookieStore, WKWebView};

    use super::SavedCookie;

    const ANSWER_WITHIN: Duration = Duration::from_secs(5);

    /// Run `f` on `webview`'s cookie store, on the main thread where WebKit
    /// wants it, and wait for what it sends back. Not for the main thread.
    fn with_store<T: Send + 'static>(
        webview: &tauri::Webview,
        f: impl FnOnce(&WKHTTPCookieStore, mpsc::Sender<T>) + Send + 'static,
    ) -> Result<T, String> {
        let (tx, rx) = mpsc::channel();
        webview
            .with_webview(move |platform| unsafe {
                let view: &WKWebView = &*platform.inner().cast();
                let store = view.configuration().websiteDataStore().httpCookieStore();
                f(&store, tx);
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(ANSWER_WITHIN)
            .map_err(|_| "The cookie store did not answer".to_string())
    }

    pub fn read_all(webview: &tauri::Webview) -> Result<Vec<SavedCookie>, String> {
        with_store(webview, |store, tx| unsafe {
            store.getAllCookies(&RcBlock::new(
                move |cookies: NonNull<NSArray<NSHTTPCookie>>| {
                    let saved = cookies
                        .as_ref()
                        .to_vec()
                        .iter()
                        .map(|cookie| saved(cookie))
                        .collect();
                    let _ = tx.send(saved);
                },
            ));
        })
    }

    /// Set `cookies`, replacing the ones of the same name, domain and path.
    pub fn write_all(webview: &tauri::Webview, cookies: Vec<SavedCookie>) -> Result<(), String> {
        with_store(webview, move |store, tx| unsafe {
            let cookies: Vec<_> = cookies.iter().filter_map(native).collect();
            let Some((last, rest)) = cookies.split_last() else {
                let _ = tx.send(());
                return;
            };
            for cookie in rest {
                store.setCookie_completionHandler(cookie, None);
            }
            // Set in order: the last one done is all of them done.
            store.setCookie_completionHandler(
                last,
                Some(&RcBlock::new(move || {
                    let _ = tx.send(());
                })),
            );
        })
    }

    fn saved(cookie: &NSHTTPCookie) -> SavedCookie {
        let same_site = cookie
            .sameSitePolicy()
            .map(|policy| policy.to_string())
            .filter(|policy| policy == "lax" || policy == "strict");
        SavedCookie {
            name: cookie.name().to_string(),
            value: cookie.value().to_string(),
            domain: cookie.domain().to_string(),
            path: cookie.path().to_string(),
            secure: cookie.isSecure(),
            http_only: cookie.isHTTPOnly(),
            same_site,
            expires: cookie
                .expiresDate()
                .map(|date| date.timeIntervalSince1970() as i64),
        }
    }

    fn native(cookie: &SavedCookie) -> Option<Retained<NSHTTPCookie>> {
        unsafe {
            let name = NSString::from_str(&cookie.name);
            let value = NSString::from_str(&cookie.value);
            let path = NSString::from_str(&cookie.path);
            let domain = NSString::from_str(&cookie.domain);
            let properties: Retained<NSMutableDictionary<_, AnyObject>> =
                NSMutableDictionary::from_slices(
                    &[
                        NSHTTPCookieName,
                        NSHTTPCookieValue,
                        NSHTTPCookiePath,
                        NSHTTPCookieDomain,
                    ],
                    &[&name, &value, &path, &domain],
                );
            if let Some(at) = cookie.expires {
                let date = NSDate::dateWithTimeIntervalSince1970(at as f64);
                properties.insert(NSHTTPCookieExpires, &*date);
                properties.insert(NSHTTPCookieVersion, ns_string!("0"));
            }
            if cookie.secure {
                properties.insert(NSHTTPCookieSecure, ns_string!("TRUE"));
            }
            if cookie.http_only {
                properties.insert(ns_string!("HttpOnly"), ns_string!("TRUE"));
            }
            // Strings, not the typed key: https://github.com/tauri-apps/wry/issues/1616
            match cookie.same_site.as_deref() {
                Some("lax") => properties.insert(ns_string!("SameSite"), ns_string!("lax")),
                Some("strict") => properties.insert(ns_string!("SameSite"), ns_string!("strict")),
                _ => {}
            }
            NSHTTPCookie::cookieWithProperties(&properties)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn cookie(domain: &str, expires: Option<i64>) -> SavedCookie {
            SavedCookie {
                name: "d".into(),
                value: "v=1".into(),
                domain: domain.into(),
                path: "/".into(),
                secure: true,
                http_only: true,
                same_site: Some("lax".into()),
                expires,
            }
        }

        #[test]
        fn a_cookie_survives_a_trip_through_webkit_as_it_was() {
            for domain in [".slack.com", "app.slack.com"] {
                let original = cookie(domain, Some(super::super::now() + 30 * 24 * 3600));
                let back = saved(&native(&original).unwrap());
                assert_eq!(back, original);
            }
        }

        #[test]
        fn a_session_cookie_stays_one_until_given_a_date() {
            let original = cookie(".slack.com", None);
            assert_eq!(saved(&native(&original).unwrap()).expires, None);
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod store {
    use super::SavedCookie;

    pub fn read_all(_: &tauri::Webview) -> Result<Vec<SavedCookie>, String> {
        Err("Logins are only kept on macOS".into())
    }

    pub fn write_all(_: &tauri::Webview, _: Vec<SavedCookie>) -> Result<(), String> {
        Err("Logins are only kept on macOS".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;

    fn cookie(name: &str, domain: &str, expires: Option<i64>) -> SavedCookie {
        SavedCookie {
            name: name.into(),
            value: "v".into(),
            domain: domain.into(),
            path: "/".into(),
            secure: true,
            http_only: true,
            same_site: Some("lax".into()),
            expires,
        }
    }

    #[test]
    fn session_cookies_get_a_lifetime() {
        let mut cookies = vec![
            cookie("session", ".slack.com", None),
            cookie("dated", ".slack.com", Some(NOW + 60)),
        ];
        let lasting = make_persistent(&mut cookies, NOW);
        assert_eq!(lasting.len(), 1);
        assert_eq!(lasting[0].name, "session");
        assert_eq!(lasting[0].expires, Some(NOW + 90 * 24 * 3600));
        assert_eq!(cookies[0].expires, Some(NOW + 90 * 24 * 3600));
        // Dated cookies keep their date; the dot that reaches subdomains stays.
        assert_eq!(cookies[1].expires, Some(NOW + 60));
        assert_eq!(lasting[0].domain, ".slack.com");
    }

    #[test]
    fn only_lasting_cookies_are_kept() {
        let cookies = vec![
            cookie("session", "a.com", None),
            cookie("old", "a.com", Some(NOW - 10)),
            cookie("fresh", "a.com", Some(NOW + 10)),
        ];
        let kept = snapshot_of(&cookies, NOW);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].name, "fresh");
    }

    #[test]
    fn restoring_fills_gaps_and_keeps_what_the_store_has() {
        let saved = vec![
            cookie("sid", ".slack.com", Some(NOW + 1000)),
            cookie("token", ".slack.com", Some(NOW + 1000)),
            cookie("lapsed", ".slack.com", Some(NOW + 1000)),
        ];
        let current = vec![cookie("token", ".slack.com", Some(NOW + 2000))];
        let names = |cookies: Vec<SavedCookie>| -> Vec<String> {
            cookies.into_iter().map(|c| c.name).collect()
        };
        assert_eq!(names(missing(&saved, &current, NOW)), ["sid", "lapsed"]);
        // Whatever has lapsed by now is not worth bringing back.
        assert!(missing(&saved, &current, NOW + 1500).is_empty());
    }

    #[test]
    fn the_same_name_on_another_domain_is_another_cookie() {
        let saved = vec![cookie("d", ".slack.com", Some(NOW + 1000))];
        let current = vec![cookie("d", "app.slack.com", Some(NOW + 1000))];
        assert_eq!(missing(&saved, &current, NOW).len(), 1);
    }

    #[test]
    fn a_snapshot_survives_its_trip_to_the_credential_store() {
        let saved = vec![cookie("sid", ".slack.com", Some(NOW + 1000))];
        let text = serde_json::to_string(&saved).unwrap();
        assert_eq!(
            serde_json::from_str::<Vec<SavedCookie>>(&text).unwrap(),
            saved
        );
    }
}
