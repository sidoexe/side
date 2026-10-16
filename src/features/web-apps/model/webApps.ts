/** A web app signed in to one account, inside its own isolated webview. */
export type WebApp = {
  id: string;
  name: string;
  url: string;
  /** The rail folder it is filed under; a folder exists while it holds one. */
  folder?: string;
};

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
/** Folders folded in this rail; not shared, like a project group's. */
const COLLAPSED_KEY = "monocode.webAppFolders.collapsed";

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
    normalizeWebAppUrl(value.url) !== null &&
    (value.folder === undefined || typeof value.folder === "string")
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
  return `${read(APPS_KEY) ?? ""}|${read(ACTIVE_KEY) ?? ""}|${read(COLLAPSED_KEY) ?? ""}`;
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

/** Asks the app to show the Web view, as the rail's web apps do. */
export const OPEN_WEB_EVENT = "monocode:open-web";

/** Make the app on `url`'s site the active one, pointed at `url`, adding it
 * as `name` when there is none. */
export function openWebAppAt(url: string, name: string): WebApp {
  const { apps, app } = withWebAppAt(loadWebApps(), url, name);
  saveWebApps(apps);
  saveActiveWebApp(app.id);
  return app;
}

/** `apps` with the app on `url`'s site pointed at `url`, or a new one. */
export function withWebAppAt(
  apps: WebApp[],
  url: string,
  name: string,
): { apps: WebApp[]; app: WebApp } {
  const origin = new URL(url).origin;
  const existing = apps.find((app) => new URL(app.url).origin === origin);
  if (!existing) {
    const app = { ...newWebApp(apps, url), name };
    return { apps: [...apps, app], app };
  }
  const app = { ...existing, url };
  return { apps: apps.map((entry) => (entry.id === app.id ? app : entry)), app };
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

/** Put `ids` in this order within the slots they already hold, so one
 * folder's apps reorder without moving anyone else. */
export function reorderWebApps(ids: readonly string[]) {
  saveWebApps(reorderWithin(loadWebApps(), ids));
}

export function reorderWithin(apps: WebApp[], ids: readonly string[]): WebApp[] {
  const byId = new Map(apps.map((app) => [app.id, app]));
  const moved = ids.flatMap((id) => byId.get(id) ?? []);
  const members = new Set(moved.map((app) => app.id));
  let next = 0;
  return apps.map((app) => (members.has(app.id) ? moved[next++] : app));
}

/** Folder names in rail order: where each one's first app stands. */
export function webAppFolders(apps: readonly WebApp[]): string[] {
  return [...new Set(apps.flatMap((app) => (app.folder ? [app.folder] : [])))];
}

/** A clean folder name, or null when nothing is left of it. */
export function normalizeWebAppFolder(name: string): string | null {
  const trimmed = name.trim().slice(0, 40);
  return trimmed || null;
}

/** File `id` under `folder`, or take it out of any with undefined. It goes
 * to the end of that folder so it shows where the user looks next. */
export function moveWebAppToFolder(id: string, folder: string | undefined) {
  const name = folder === undefined ? undefined : normalizeWebAppFolder(folder);
  if (name === null) return;
  const apps = loadWebApps();
  const app = apps.find((entry) => entry.id === id);
  if (!app || app.folder === name) return;
  const { folder: _previous, ...rest } = app;
  const moved: WebApp = name ? { ...rest, folder: name } : rest;
  const others = apps.filter((entry) => entry.id !== id);
  let last = -1;
  if (name)
    others.forEach((entry, index) => {
      if (entry.folder === name) last = index;
    });
  others.splice(last === -1 ? others.length : last + 1, 0, moved);
  saveWebApps(others);
  if (name) setWebAppFolderCollapsed(name, false);
}

export function renameWebAppFolder(from: string, to: string) {
  const name = normalizeWebAppFolder(to);
  if (!name || name === from) return;
  saveWebApps(
    loadWebApps().map((app) =>
      app.folder === from ? { ...app, folder: name } : app,
    ),
  );
  if (loadCollapsedWebAppFolders().has(from)) {
    setWebAppFolderCollapsed(from, false);
    setWebAppFolderCollapsed(name, true);
  }
}

/** Take every app out of `folder`, which then no longer exists. */
export function ungroupWebAppFolder(folder: string) {
  saveWebApps(
    loadWebApps().map((app) => {
      if (app.folder !== folder) return app;
      const { folder: _folder, ...rest } = app;
      return rest;
    }),
  );
  setWebAppFolderCollapsed(folder, false);
}

export function loadCollapsedWebAppFolders(): Set<string> {
  return new Set(
    parseJson(read(COLLAPSED_KEY)).filter(
      (name): name is string => typeof name === "string",
    ),
  );
}

export function setWebAppFolderCollapsed(folder: string, collapsed: boolean) {
  const names = loadCollapsedWebAppFolders();
  if (names.has(folder) === collapsed) return;
  if (collapsed) names.add(folder);
  else names.delete(folder);
  write(COLLAPSED_KEY, JSON.stringify([...names]));
  changed();
}

function parseJson(raw: string | null): unknown[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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
