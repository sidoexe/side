import { invoke, isTauri } from "@tauri-apps/api/core";

/** Each site's icon as a `data:` URL, by origin, with when it was fetched; ""
 * remembers a site that has none, so it isn't asked again every launch. */
const ICONS_KEY = "monocode.webApps.icons";
const FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const MISSING_RETRY_MS = 24 * 60 * 60 * 1000;

type Entry = { icon: string; at: number };

const CHANGED = "monocode:web-app-icons-changed";
const inFlight = new Set<string>();
/** Parsed once: rows read it on every render. */
let cache: Record<string, Entry> | null = null;

function readAll(): Record<string, Entry> {
  if (cache) return cache;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(ICONS_KEY) ?? "");
    cache =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, Entry>)
        : {};
  } catch {
    cache = {};
  }
  return cache;
}

function store(origin: string, icon: string) {
  cache = { ...readAll(), [origin]: { icon, at: Date.now() } };
  try {
    localStorage.setItem(ICONS_KEY, JSON.stringify(cache));
  } catch {
    // quota: the icon still shows from the cache until the next launch
  }
  window.dispatchEvent(new Event(CHANGED));
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The icon of `url`'s site, or null while there is none. */
export function webAppIcon(url: string): string | null {
  const origin = originOf(url);
  return (origin && readAll()[origin]?.icon) || null;
}

/** Fetch `url`'s site icon in the background when missing or stale. */
export function refreshWebAppIcon(url: string) {
  const origin = originOf(url);
  if (!origin) return;
  const entry = readAll()[origin];
  const age = entry ? Date.now() - entry.at : Infinity;
  const stale = entry?.icon ? age > FRESH_MS : age > MISSING_RETRY_MS;
  if (stale && isTauri() && !inFlight.has(origin)) {
    inFlight.add(origin);
    void invoke<string | null>("web_app_icon", { url })
      .then((icon) => {
        // A failed refresh keeps the icon already shown.
        if (icon || !entry?.icon) store(origin, icon ?? "");
      })
      .catch(() => {})
      .finally(() => inFlight.delete(origin));
  }
}

export function subscribeWebAppIcons(onChange: () => void): () => void {
  window.addEventListener(CHANGED, onChange);
  return () => window.removeEventListener(CHANGED, onChange);
}
