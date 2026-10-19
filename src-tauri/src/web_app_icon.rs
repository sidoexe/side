//! A web app's icon for the rail: the one its home page names, else
//! `/favicon.ico`. Fetched here and handed over as a `data:` URL, so the UI's
//! `img-src` never opens to every site the user adds.

use std::io::Read;
use std::time::Duration;

use base64::Engine;
use url::Url;

const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PAGE_BYTES: u64 = 1024 * 1024;
const MAX_ICON_BYTES: u64 = 256 * 1024;
/// As in `web_embed`: some sites only serve a full page to a browser.
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

/// `url`'s icon as a `data:` URL, or None when the site has none we can read.
#[tauri::command]
pub async fn web_app_icon(url: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || icon(&url))
        .await
        .map_err(|e| e.to_string())
}

fn icon(url: &str) -> Option<String> {
    let page: Url = url.trim().parse().ok()?;
    if !matches!(page.scheme(), "https" | "http") || page.host_str().is_none() {
        return None;
    }
    let agent = ureq::AgentBuilder::new()
        .timeout(HTTP_TIMEOUT)
        .redirects(5)
        .build();
    let mut candidates = Vec::new();
    if let Ok(response) = agent
        .get(page.as_str())
        .set("User-Agent", USER_AGENT)
        .set("Accept", "text/html")
        .call()
    {
        let base: Url = response.get_url().parse().unwrap_or_else(|_| page.clone());
        if let Some(html) = read(response, MAX_PAGE_BYTES) {
            candidates = icon_links(&String::from_utf8_lossy(&html), &base);
        }
    }
    if let Ok(fallback) = page.join("/favicon.ico") {
        candidates.push(fallback);
    }
    candidates.into_iter().find_map(|candidate| {
        if !matches!(candidate.scheme(), "https" | "http") {
            return None;
        }
        let response = agent
            .get(candidate.as_str())
            .set("User-Agent", USER_AGENT)
            .set("Accept", "image/*")
            .call()
            .ok()?;
        let declared = response.content_type().to_ascii_lowercase();
        let bytes = read(response, MAX_ICON_BYTES)?;
        let mime = sniff(&bytes).or_else(|| {
            (declared.starts_with("image/") && declared != "image/svg+xml")
                .then_some(declared.as_str())
        })?;
        Some(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        ))
    })
}

/// The body when it is a success no larger than `limit`.
fn read(response: ureq::Response, limit: u64) -> Option<Vec<u8>> {
    if !(200..300).contains(&response.status()) {
        return None;
    }
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (!bytes.is_empty() && bytes.len() as u64 <= limit).then_some(bytes)
}

/// The image format `bytes` hold, from their first bytes.
fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG") {
        Some("image/png")
    } else if bytes.starts_with(&[0, 0, 1, 0]) {
        Some("image/x-icon")
    } else if bytes.starts_with(b"\xFF\xD8\xFF") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF8") {
        Some("image/gif")
    } else if bytes.len() > 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(1024)]).to_ascii_lowercase();
        head.contains("<svg").then_some("image/svg+xml")
    }
}

/// The icons `html` links to, best first: the large touch icon, then the
/// others, larger before smaller.
fn icon_links(html: &str, base: &Url) -> Vec<Url> {
    let lower = html.to_ascii_lowercase();
    let mut found: Vec<(u32, Url)> = Vec::new();
    let mut from = 0;
    while let Some(start) = lower[from..].find("<link").map(|at| from + at) {
        let end = lower[start..]
            .find('>')
            .map_or(lower.len(), |at| start + at);
        from = end;
        let tag = &html[start..end];
        let Some(rel) = attribute(tag, "rel") else {
            continue;
        };
        let rel = rel.to_ascii_lowercase();
        let words: Vec<&str> = rel.split_ascii_whitespace().collect();
        let rank = if words.contains(&"apple-touch-icon") {
            1000
        } else if words.contains(&"icon") {
            attribute(tag, "sizes")
                .and_then(|sizes| {
                    sizes
                        .split(['x', 'X'])
                        .next()
                        .and_then(|side| side.trim().parse::<u32>().ok())
                })
                .unwrap_or(16)
                .min(999)
        } else {
            continue;
        };
        if let Some(href) = attribute(tag, "href") {
            if let Ok(url) = base.join(&href.replace("&amp;", "&")) {
                found.push((rank, url));
            }
        }
    }
    found.sort_by_key(|(rank, _)| std::cmp::Reverse(*rank));
    found.into_iter().map(|(_, url)| url).collect()
}

/// The value of `name` in an HTML tag, quoted or not.
fn attribute(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(at) = lower[from..].find(name).map(|at| from + at) {
        from = at + name.len();
        let before = lower[..at].chars().last();
        if !before.is_some_and(|c| c.is_ascii_whitespace()) {
            continue;
        }
        let rest = lower[from..].trim_start();
        let Some(rest) = rest.strip_prefix('=') else {
            continue;
        };
        let value_at = lower.len() - rest.trim_start().len();
        let value = &tag[value_at..];
        return Some(match value.chars().next()? {
            quote @ ('"' | '\'') => value[1..].split(quote).next()?.to_string(),
            _ => value
                .split(|c: char| c.is_ascii_whitespace() || c == '>')
                .next()?
                .to_string(),
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn touch_icon_comes_first_then_larger_icons() {
        let base: Url = "https://linear.app/team".parse().unwrap();
        let html = r#"<head>
            <link rel="stylesheet" href="/a.css">
            <LINK REL="icon" sizes="16x16" href="/16.png">
            <link href='/32.png' rel='shortcut icon' sizes='32x32'>
            <link rel=apple-touch-icon href=https://cdn.linear.app/touch.png>
            <link rel="icon" href="/x.svg?v=1&amp;b=2">
        </head>"#;
        let links: Vec<String> = icon_links(html, &base)
            .into_iter()
            .map(String::from)
            .collect();
        assert_eq!(
            links,
            [
                "https://cdn.linear.app/touch.png",
                "https://linear.app/32.png",
                "https://linear.app/16.png",
                "https://linear.app/x.svg?v=1&b=2",
            ]
        );
    }

    #[test]
    fn attributes_need_their_whole_name() {
        assert_eq!(
            attribute(r#"<link data-href="/no" href="/yes">"#, "href").as_deref(),
            Some("/yes")
        );
        assert_eq!(
            attribute("<link rel = icon>", "rel").as_deref(),
            Some("icon")
        );
        assert_eq!(attribute("<link rel>", "rel"), None);
    }

    #[test]
    fn formats_come_from_the_bytes() {
        assert_eq!(sniff(b"\x89PNG\r\n"), Some("image/png"));
        assert_eq!(sniff(&[0, 0, 1, 0, 1]), Some("image/x-icon"));
        assert_eq!(sniff(b"<?xml?><svg xmlns=..."), Some("image/svg+xml"));
        assert_eq!(sniff(b"<!doctype html><html>"), None);
    }
}
