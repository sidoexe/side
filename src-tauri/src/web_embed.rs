//! Web apps (Linear, Notion, Slack…) as native child webviews of the window.
//! Most of them refuse to be framed (`X-Frame-Options`), so each page lives in
//! its own WKWebView laid over the area the Web view reserves.
//!
//! Each app is signed in to one account: its own webview over its own
//! persistent data store, so two logins to the same site never share or
//! overwrite each other's cookies. Webviews stay alive while hidden; the
//! stores keep logins across launches, and `web_session` keeps them from
//! expiring or getting lost.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Mutex, Once, OnceLock};
use std::time::Duration;

use tauri::webview::{Cookie, NewWindowFeatures, NewWindowResponse, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, Url, WebviewUrl,
    WebviewWindowBuilder, Window,
};

use crate::web_session;

/// The first app, whose id predates UUIDs. It gets a store of its own like
/// every other: WebKit's default store is the one sIDE's own UI lives in, so
/// signing an app out must never clear it.
const DEFAULT_APP: &str = "default";
const DEFAULT_APP_STORE: uuid::Uuid = uuid::uuid!("5ce1a7e0-6d2b-4b8e-9f3a-2c7d1e0b4a91");

/// Sign-in popups opened by an embedded app: their own windows, never
/// workspaces.
pub const POPUP_PREFIX: &str = "web-popup-";

/// Google sign-in rejects embedded browsers it doesn't recognise; present as
/// Safari, which shares the WebKit engine anyway.
#[cfg(target_os = "macos")]
const USER_AGENT: Option<&str> = Some(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
);
#[cfg(not(target_os = "macos"))]
const USER_AGENT: Option<&str> = None;

/// The page's zoom chords never reach sIDE's own keyboard handling while the
/// page has focus, so the page asks for them by navigating here; the
/// navigation is cancelled and the request handed to the window.
const ZOOM_SCHEME: &str = "side-zoom";

const ZOOM_KEYS_SCRIPT: &str = r#"(() => {
  if (window.top !== window) return;
  addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing) return;
    const action =
      event.key === "=" || event.key === "+" ? "in"
      : event.key === "-" ? "out"
      : event.key === "0" ? "reset"
      : null;
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    location.href = "side-zoom:" + action;
  }, true);
})();"#;

#[derive(serde::Serialize, Clone)]
struct ZoomKey {
    app: String,
    action: String,
}

#[derive(serde::Deserialize, Clone, Copy, Debug)]
pub struct WebEmbedBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// The id of an app's dedicated data store.
fn app_store(app: &str) -> Result<uuid::Uuid, String> {
    if app == DEFAULT_APP {
        return Ok(DEFAULT_APP_STORE);
    }
    uuid::Uuid::parse_str(app).map_err(|_| format!("Unknown web app: {app}"))
}

/// Only the web: no `file:`, no custom schemes, nothing local to the machine.
fn app_url(url: &str) -> Result<Url, String> {
    let parsed: Url = url
        .trim()
        .parse()
        .map_err(|_| format!("Invalid URL: {url}"))?;
    match parsed.scheme() {
        "https" | "http" if parsed.host_str().is_some() => Ok(parsed),
        _ => Err(format!("Only web addresses can be embedded: {url}")),
    }
}

fn label_prefix(window: &Window) -> String {
    format!("web-embed-{}-", window.label())
}

fn embed_label(window: &Window, store: uuid::Uuid) -> String {
    format!("{}{}", label_prefix(window), store.simple())
}

fn rect(bounds: WebEmbedBounds) -> Rect {
    Rect {
        position: LogicalPosition::new(bounds.x, bounds.y).into(),
        size: LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)).into(),
    }
}

/// Pages stay in the webview; anything that isn't the web (mailto:, linear://)
/// is dropped rather than handed to the OS on the page's say-so.
fn allows_navigation(url: &Url) -> bool {
    matches!(url.scheme(), "https" | "http" | "about" | "blob" | "data")
}

fn open_externally(url: &Url) {
    if matches!(url.scheme(), "https" | "http") {
        let _ = open::that_detached(url.as_str());
    }
}

/// `window.open` with a size is a popup the page talks back to, typically
/// "Sign in with Google": it must share the app's store, so it opens here.
/// A plain new tab is an outside link and goes to the browser.
fn open_new_window(
    app: &AppHandle,
    url: Url,
    features: NewWindowFeatures,
) -> NewWindowResponse<tauri::Wry> {
    if features.size().is_none() || !allows_navigation(&url) {
        open_externally(&url);
        return NewWindowResponse::Deny;
    }
    let label = format!("{POPUP_PREFIX}{}", uuid::Uuid::new_v4().simple());
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .window_features(features)
        .title("Sign in")
        .on_navigation(allows_navigation)
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
        });
    if let Some(agent) = USER_AGENT {
        builder = builder.user_agent(agent);
    }
    match builder.build() {
        Ok(window) => NewWindowResponse::Create { window },
        Err(_) => NewWindowResponse::Deny,
    }
}

/// Where a dedicated store lives off macOS, where WebKit has no store ids.
fn store_directory(window: &Window, id: uuid::Uuid) -> Result<PathBuf, String> {
    Ok(window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("web-apps")
        .join(id.simple().to_string()))
}

fn hide_others(window: &Window, keep: &str) {
    let prefix = label_prefix(window);
    for (label, webview) in window.app_handle().webviews() {
        if label.starts_with(&prefix) && label != keep {
            let _ = webview.hide();
        }
    }
}

/// Pinch-to-zoom inside the page, as in Safari; WKWebView ships with it off.
#[cfg(target_os = "macos")]
fn allow_pinch(webview: &tauri::Webview) {
    let _ = webview.with_webview(|platform| unsafe {
        let view: &objc2::runtime::AnyObject = &*platform.inner().cast();
        let _: () = objc2::msg_send![view, setAllowsMagnification: true];
    });
}

/// Undo a pinch, back to the page at its zoom.
#[cfg(target_os = "macos")]
fn reset_pinch(webview: &tauri::Webview) {
    let _ = webview.with_webview(|platform| unsafe {
        let view: &objc2::runtime::AnyObject = &*platform.inner().cast();
        let _: () = objc2::msg_send![view, setMagnification: 1.0f64];
    });
}

/// Page zooms the app can be set to.
fn clamp_zoom(zoom: f64) -> f64 {
    if zoom.is_finite() {
        zoom.clamp(0.25, 5.0)
    } else {
        1.0
    }
}

/// Show `app`'s webview at `bounds` (logical pixels, relative to the window)
/// and `zoom`, opening `url` on first use, and hide the window's other apps. Async:
/// `add_child` hops to the main thread and waits, which would deadlock a
/// command already running there.
#[tauri::command]
pub async fn web_embed_show(
    window: Window,
    app: String,
    url: String,
    bounds: WebEmbedBounds,
    zoom: Option<f64>,
) -> Result<(), String> {
    let store = app_store(&app)?;
    let label = embed_label(&window, store);
    let zoom = clamp_zoom(zoom.unwrap_or(1.0));
    hide_others(&window, &label);
    if let Some(webview) = window.app_handle().get_webview(&label) {
        webview
            .set_bounds(rect(bounds))
            .map_err(|e| e.to_string())?;
        let _ = webview.set_zoom(zoom);
        webview.show().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let home = app_url(&url)?;
    // A login from another desktop, or the snapshot of this one's, goes into
    // the store before the page loads, so the page opens signed in.
    let pending = take_pending(store);
    let saved = web_session::snapshot(store);
    let first = if pending.is_some() || saved.is_some() {
        WebviewUrl::External(
            "about:blank"
                .parse()
                .map_err(|e: url::ParseError| e.to_string())?,
        )
    } else {
        WebviewUrl::External(home.clone())
    };
    let handle = window.app_handle().clone();
    let zoom_keys = (
        window.app_handle().clone(),
        window.label().to_string(),
        app.clone(),
    );
    let mut builder = WebviewBuilder::new(&label, first)
        .initialization_script(ZOOM_KEYS_SCRIPT)
        .on_navigation(move |url| {
            if url.scheme() == ZOOM_SCHEME {
                let (handle, window, app) = &zoom_keys;
                let _ = handle.emit_to(
                    window.as_str(),
                    "web_embed_zoom_key",
                    ZoomKey {
                        app: app.clone(),
                        action: url.path().to_string(),
                    },
                );
                return false;
            }
            allows_navigation(url)
        })
        .on_new_window(move |url, features| open_new_window(&handle, url, features));
    if let Some(agent) = USER_AGENT {
        builder = builder.user_agent(agent);
    }
    builder = if cfg!(target_vendor = "apple") {
        builder.data_store_identifier(*store.as_bytes())
    } else {
        builder.data_directory(store_directory(&window, store)?)
    };
    let r = rect(bounds);
    let webview = window
        .add_child(builder, r.position, r.size)
        .map_err(|e| e.to_string())?;
    let _ = webview.set_zoom(zoom);
    #[cfg(target_os = "macos")]
    allow_pinch(&webview);
    if pending.is_some() || saved.is_some() {
        // Another desktop's login is the newer one, so it goes in last.
        if let Some(saved) = saved {
            saved.restore(&webview);
        }
        if let Some(cookies) = pending {
            set_cookies(&webview, &cookies);
        }
        webview.navigate(home).map_err(|e| e.to_string())?;
    }
    keep_logins(window.app_handle());
    Ok(())
}

/// How often open apps' logins are made lasting and snapshotted.
const KEEP_EVERY: Duration = Duration::from_secs(30);

/// One webview per store that has one open.
fn open_stores(app: &AppHandle) -> Vec<(uuid::Uuid, tauri::Webview)> {
    let mut seen = HashSet::new();
    app.webviews()
        .into_iter()
        .filter_map(|(label, webview)| {
            let id = label.strip_prefix("web-embed-")?.rsplit('-').next()?;
            let store = uuid::Uuid::parse_str(id).ok()?;
            seen.insert(store).then_some((store, webview))
        })
        .collect()
}

fn keep_all(app: &AppHandle) {
    for (store, webview) in open_stores(app) {
        let _ = web_session::keep(&webview, store);
    }
}

/// Keep every open app's login from lapsing, from now on, until sIDE quits.
fn keep_logins(app: &AppHandle) {
    static STARTED: Once = Once::new();
    let app = app.clone();
    STARTED.call_once(move || {
        std::thread::spawn(move || loop {
            std::thread::sleep(KEEP_EVERY);
            keep_all(&app);
        });
    });
}

/// Logins received for apps whose webview isn't open yet, by store.
fn pending() -> &'static Mutex<HashMap<uuid::Uuid, Vec<String>>> {
    static PENDING: OnceLock<Mutex<HashMap<uuid::Uuid, Vec<String>>>> = OnceLock::new();
    PENDING.get_or_init(Default::default)
}

fn take_pending(store: uuid::Uuid) -> Option<Vec<String>> {
    pending().lock().ok()?.remove(&store)
}

/// Any open webview over `store`; they all share its cookies.
fn store_webview(window: &Window, store: uuid::Uuid) -> Option<tauri::Webview> {
    let suffix = format!("-{}", store.simple());
    window
        .app_handle()
        .webviews()
        .into_iter()
        .find(|(label, _)| label.starts_with("web-embed-") && label.ends_with(&suffix))
        .map(|(_, webview)| webview)
}

/// Unparseable entries are skipped: a login is best-effort, never an error
/// that keeps the app from opening.
fn set_cookies(webview: &tauri::Webview, cookies: &[String]) {
    for cookie in cookies {
        if let Ok(cookie) = Cookie::parse(cookie.clone()) {
            let _ = webview.set_cookie(cookie);
        }
    }
}

/// `app`'s cookies as `Set-Cookie` strings, so another desktop can sign in
/// with them; None while its webview isn't open.
#[tauri::command]
pub async fn web_embed_cookies(window: Window, app: String) -> Result<Option<Vec<String>>, String> {
    let Some(webview) = store_webview(&window, app_store(&app)?) else {
        return Ok(None);
    };
    // Lasting first, so what another desktop gets has a lifetime too.
    let _ = web_session::keep(&webview, app_store(&app)?);
    let cookies = webview.cookies().map_err(|e| e.to_string())?;
    Ok(Some(cookies.iter().map(ToString::to_string).collect()))
}

/// Sign `app` in with cookies from another desktop: straight into its store
/// when its webview is open, reloading it on a sign-in (`reload`) but not for
/// a refreshed token, else when it next opens.
#[tauri::command]
pub async fn web_embed_set_cookies(
    window: Window,
    app: String,
    cookies: Vec<String>,
    reload: bool,
) -> Result<(), String> {
    let store = app_store(&app)?;
    match store_webview(&window, store) {
        Some(webview) => {
            set_cookies(&webview, &cookies);
            if reload {
                webview.reload().map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        None => {
            if let Ok(mut pending) = pending().lock() {
                pending.insert(store, cookies);
            }
            Ok(())
        }
    }
}

/// Keep the webviews, and so the pages and their logins, but take them off
/// screen.
#[tauri::command]
pub async fn web_embed_hide(window: Window) -> Result<(), String> {
    hide_others(&window, "");
    // Leaving an app is a good moment to save its login, off the way of the UI.
    let app = window.app_handle().clone();
    std::thread::spawn(move || keep_all(&app));
    Ok(())
}

/// Set `app`'s page zoom (1 = 100%); `reset_pinch` also undoes a trackpad
/// pinch.
#[tauri::command]
pub async fn web_embed_zoom(
    window: Window,
    app: String,
    zoom: f64,
    reset_pinch: bool,
) -> Result<(), String> {
    let label = embed_label(&window, app_store(&app)?);
    let Some(webview) = window.app_handle().get_webview(&label) else {
        return Ok(());
    };
    webview
        .set_zoom(clamp_zoom(zoom))
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    if reset_pinch {
        self::reset_pinch(&webview);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = reset_pinch;
    Ok(())
}

/// Reload `app`, or go back to its `home` page when given.
#[tauri::command]
pub async fn web_embed_reload(
    window: Window,
    app: String,
    home: Option<String>,
) -> Result<(), String> {
    let label = embed_label(&window, app_store(&app)?);
    let Some(webview) = window.app_handle().get_webview(&label) else {
        return Ok(());
    };
    match home {
        Some(url) => webview.navigate(app_url(&url)?).map_err(|e| e.to_string()),
        None => webview.reload().map_err(|e| e.to_string()),
    }
}

/// Close `app` and sign it out for good: its cookies and storage go too.
#[tauri::command]
pub async fn web_embed_forget(window: Window, app: String) -> Result<(), String> {
    let store = app_store(&app)?;
    take_pending(store);
    web_session::forget(store);
    if let Some(webview) = window
        .app_handle()
        .get_webview(&embed_label(&window, store))
    {
        let _ = webview.clear_all_browsing_data();
        webview.close().map_err(|e| e.to_string())?;
    }
    #[cfg(target_vendor = "apple")]
    {
        // WebKit refuses while the store is still in use; the cleared data
        // above is what matters, the empty store is best-effort.
        let _ = window
            .app_handle()
            .remove_data_store(*store.as_bytes())
            .await;
    }
    #[cfg(not(target_vendor = "apple"))]
    {
        let _ = std::fs::remove_dir_all(store_directory(&window, store)?);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_stays_on_the_web() {
        assert!(allows_navigation(
            &"https://linear.app/team/issue/ABC-1".parse().unwrap()
        ));
        assert!(allows_navigation(
            &"https://accounts.google.com/o/oauth2".parse().unwrap()
        ));
        assert!(!allows_navigation(&"linear://open".parse().unwrap()));
        assert!(!allows_navigation(&"file:///etc/passwd".parse().unwrap()));
    }

    #[test]
    fn only_web_addresses_are_embedded() {
        assert!(app_url("https://linear.app").is_ok());
        assert!(app_url(" http://localhost:3000/ ").is_ok());
        assert!(app_url("file:///etc/passwd").is_err());
        assert!(app_url("javascript:alert(1)").is_err());
        assert!(app_url("linear.app").is_err());
    }

    #[test]
    fn cookies_round_trip_as_set_cookie_strings() {
        let text = "session=abc; HttpOnly; Secure; Path=/; Domain=linear.app";
        let cookie = Cookie::parse(text.to_string()).unwrap();
        let again = Cookie::parse(cookie.to_string()).unwrap();
        assert_eq!(again.name_value(), ("session", "abc"));
        assert_eq!(again.domain(), Some("linear.app"));
        assert_eq!(again.http_only(), Some(true));
        assert_eq!(again.secure(), Some(true));
    }

    #[test]
    fn zoom_stays_in_range() {
        assert_eq!(clamp_zoom(1.25), 1.25);
        assert_eq!(clamp_zoom(0.0), 0.25);
        assert_eq!(clamp_zoom(40.0), 5.0);
        assert_eq!(clamp_zoom(f64::NAN), 1.0);
    }

    #[test]
    fn zoom_requests_are_not_navigations() {
        let url: Url = "side-zoom:in".parse().unwrap();
        assert_eq!(url.scheme(), ZOOM_SCHEME);
        assert_eq!(url.path(), "in");
        assert!(!allows_navigation(&url));
    }

    #[test]
    fn bounds_never_collapse_to_zero() {
        let r = rect(WebEmbedBounds {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: -4.0,
        });
        let tauri::Size::Logical(size) = r.size else {
            panic!("logical size")
        };
        assert_eq!((size.width, size.height), (1.0, 1.0));
    }

    #[test]
    fn every_app_has_its_own_store() {
        // Never nil: that would be no store id at all, i.e. sIDE's own.
        assert_eq!(app_store("default"), Ok(DEFAULT_APP_STORE));
        assert!(!DEFAULT_APP_STORE.is_nil());
        let id = "6f1c2a4e-0b7d-4c55-9a3e-2f8b1d6c7e90";
        assert_eq!(app_store(id), Ok(uuid::Uuid::parse_str(id).unwrap()));
        assert!(app_store("../../etc").is_err());
        assert!(app_store("").is_err());
    }
}
