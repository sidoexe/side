/** A web app signed in to one account, inside its own isolated webview. */
export type WebApp = { id: string; name: string; url: string };

/** The app the view starts with. Its id predates UUIDs; the native side
 * maps it to a store of its own, like every other app. */
export const DEFAULT_WEB_APP: WebApp = {
  id: "default",
  name: "Linear",
  url: "https://linear.app",
};

const APPS_KEY = "monocode.webApps";
const ACTIVE_KEY = "monocode.webApp";
/** When the list last changed, here or on the desktop it came from. */
const UPDATED_KEY = "monocode.webApps.updatedAt";
/** Before any site could be added, the view only held Linear accounts. */
const LEGACY_LINEAR_KEY = "monocode.linearSpaces";
const LEGACY_ACTIVE_KEY = "monocode.linearSpace";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode / quota
  }
}

function parseList(raw: string | null): Record<string, unknown>[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "");
    return Array.isArray(parsed)
      ? parsed.filter((item) => item && typeof item === "object")
      : [];
  } catch {
    return [];
  }
}

function isApp(value: Record<string, unknown>): value is WebApp {
  return (
    typeof value.id === "string" &&
    value.id !== "" &&
    typeof value.name === "string" &&
    typeof value.url === "string" &&
    normalizeWebAppUrl(value.url) !== null
  );
}

export function loadWebApps(): WebApp[] {
  const apps = parseList(read(APPS_KEY)).filter(isApp);
  if (apps.length > 0) return apps;
  const legacy = parseList(read(LEGACY_LINEAR_KEY))
    .map((space) => ({ ...space, url: DEFAULT_WEB_APP.url }))
    .filter(isApp);
  return legacy.length > 0 ? legacy : [DEFAULT_WEB_APP];
}

const CHANGED = "monocode:web-apps-changed";

function changed() {
  window.dispatchEvent(new Event(CHANGED));
}

export function subscribeWebApps(onChange: () => void): () => void {
  window.addEventListener(CHANGED, onChange);
  return () => window.removeEventListener(CHANGED, onChange);
}

/** Snapshot for `useSyncExternalStore`; stable while storage is unchanged. */
export function webAppsSnapshot(): string {
  return `${read(APPS_KEY) ?? ""}|${read(ACTIVE_KEY) ?? ""}`;
}

export function saveWebApps(apps: WebApp[]) {
  write(APPS_KEY, JSON.stringify(apps));
  write(UPDATED_KEY, String(Date.now()));
  changed();
}

/** 0 for a list never edited: any host's list is newer. */
export function webAppsUpdatedAt(): number {
  return Number(read(UPDATED_KEY)) || 0;
}

/** Take a newer list from elsewhere, keeping its time so it isn't sent back
 * as a change of ours. */
export function adoptWebApps(apps: WebApp[], updatedAt: number) {
  const valid = apps.filter((app) =>
    isApp(app as unknown as Record<string, unknown>),
  );
  if (valid.length === 0) return;
  write(APPS_KEY, JSON.stringify(valid));
  write(UPDATED_KEY, String(updatedAt));
  changed();
}

export function loadActiveWebApp(apps: WebApp[]): string {
  const id = read(ACTIVE_KEY) ?? read(LEGACY_ACTIVE_KEY);
  return apps.find((app) => app.id === id)?.id ?? apps[0].id;
}

export function saveActiveWebApp(id: string) {
  write(ACTIVE_KEY, id);
  changed();
}

/** Add the page the user typed and make it the active app; null when it
 * isn't a web address. */
export function addWebApp(input: string): WebApp | null {
  const url = normalizeWebAppUrl(input);
  if (!url) return null;
  const apps = loadWebApps();
  const app = newWebApp(apps, url);
  saveWebApps([...apps, app]);
  saveActiveWebApp(app.id);
  return app;
}

export function renameWebApp(id: string, name: string) {
  const trimmed = name.trim().slice(0, 40);
  if (!trimmed) return;
  saveWebApps(
    loadWebApps().map((app) => (app.id === id ? { ...app, name: trimmed } : app)),
  );
}

/** Drop `id` from the list; the active app moves to the first one left. */
export function deleteWebApp(id: string) {
  const apps = loadWebApps();
  const next = removeWebApp(apps, id);
  saveWebApps(next);
  if (loadActiveWebApp(apps) === id) saveActiveWebApp(next[0].id);
}

export function reorderWebApps(ids: readonly string[]) {
  const order = new Map(ids.map((id, index) => [id, index]));
  saveWebApps(
    [...loadWebApps()].sort(
      (a, b) =>
        (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    ),
  );
}

/** What the user typed as a page to open: `linear.app` means https. Only
 * web addresses; anything else is null. */
export function normalizeWebAppUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** `app.slack.com` → Slack, `linear.app` → Linear. */
export function webAppName(url: string): string {
  const host = new URL(url).hostname.replace(/^(www|app)\./, "");
  const word = host.split(".")[0] || host;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** A new app on `url`, with a fresh isolated store and a name of its own:
 * a second Linear account becomes "Linear 2". */
export function newWebApp(apps: WebApp[], url: string): WebApp {
  const base = webAppName(url);
  const names = new Set(apps.map((app) => app.name));
  let name = base;
  for (let n = 2; names.has(name); n += 1) name = `${base} ${n}`;
  return { id: crypto.randomUUID(), name, url };
}

/** Drop `id`, never leaving the list empty. */
export function removeWebApp(apps: WebApp[], id: string): WebApp[] {
  const next = apps.filter((app) => app.id !== id);
  return next.length > 0 ? next : [DEFAULT_WEB_APP];
}
