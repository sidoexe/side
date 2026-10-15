import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The web apps of the desktop's rail (Linear, Notion…) and, for each, the
 * cookies of its login. Every desktop sends what changed and takes what is
 * newer, so a list edited or an account signed in on one desktop reaches the
 * others; the browser app lists the apps too.
 *
 * The cookies are live sessions: anyone who can read this directory, or call
 * this host with a valid token, can use those accounts. They are kept apart
 * from the list, readable by this user only, and dropped with their app.
 */

export type HostWebApp = { id: string; name: string; url: string };

export type HostWebAppsState = {
  apps: HostWebApp[];
  /** When the list last changed, on the desktop that changed it. */
  updatedAt: number;
};

export type HostWebAppSession = {
  /** `Set-Cookie` strings, as the app's webview holds them. */
  cookies: string[];
  updatedAt: number;
};

const MAX_APPS = 50;
const MAX_COOKIES = 400;
const MAX_COOKIE_LENGTH = 8_192;
const ID = /^(default|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function appId(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error("Invalid web app");
  return value.toLowerCase();
}

function stamp(value: unknown): number {
  const time = Number(value);
  if (!Number.isFinite(time) || time < 0) throw new Error("Invalid timestamp");
  return time;
}

function webUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_000) throw new Error("Invalid web app address");
  const url = new URL(value);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname)
    throw new Error("Only web addresses can be web apps");
  return url.href;
}

function apps(value: unknown): HostWebApp[] {
  if (!Array.isArray(value) || value.length > MAX_APPS) throw new Error("Invalid web apps");
  const out: HostWebApp[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") throw new Error("Invalid web apps");
    const { id, name, url } = entry as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim() || name.length > 40) throw new Error("Invalid web app name");
    const app = { id: appId(id), name: name.trim(), url: webUrl(url) };
    if (!out.some((other) => other.id === app.id)) out.push(app);
  }
  return out;
}

function cookies(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_COOKIES) throw new Error("Invalid cookies");
  return value.map((cookie) => {
    if (typeof cookie !== "string" || !cookie || cookie.length > MAX_COOKIE_LENGTH) throw new Error("Invalid cookies");
    return cookie;
  });
}

export class HostWebApps {
  private state: HostWebAppsState;
  private sessions: Record<string, HostWebAppSession>;

  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.state = this.loadState();
    this.sessions = this.loadSessions();
  }

  private get stateFile() {
    return join(this.directory, "web-apps.json");
  }

  private get sessionsFile() {
    return join(this.directory, "web-sessions.json");
  }

  private loadState(): HostWebAppsState {
    try {
      const value = JSON.parse(readFileSync(this.stateFile, "utf8")) as Record<string, unknown>;
      return { apps: apps(value.apps), updatedAt: stamp(value.updatedAt) };
    } catch {
      return { apps: [], updatedAt: 0 };
    }
  }

  private loadSessions(): Record<string, HostWebAppSession> {
    try {
      const value = JSON.parse(readFileSync(this.sessionsFile, "utf8")) as Record<string, Record<string, unknown>>;
      const out: Record<string, HostWebAppSession> = {};
      for (const [id, session] of Object.entries(value))
        out[appId(id)] = { cookies: cookies(session.cookies), updatedAt: stamp(session.updatedAt) };
      return out;
    } catch {
      return {};
    }
  }

  private save() {
    writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    writeFileSync(this.sessionsFile, JSON.stringify(this.sessions), { mode: 0o600 });
  }

  get(): HostWebAppsState {
    return this.state;
  }

  /** Takes the desktop's list when it is newer than the one kept; either way
   * answers with the list now kept, so an older desktop catches up. A removed
   * app's login goes with it. */
  set(input: Record<string, unknown>): HostWebAppsState {
    const next = { apps: apps(input.apps), updatedAt: stamp(input.updatedAt) };
    if (next.updatedAt <= this.state.updatedAt) return this.state;
    this.state = next;
    const kept = new Set(next.apps.map((app) => app.id));
    for (const id of Object.keys(this.sessions)) if (!kept.has(id)) delete this.sessions[id];
    this.save();
    return this.state;
  }

  /** The login kept for an app, if any. */
  session(input: Record<string, unknown>): HostWebAppSession | null {
    return this.sessions[appId(input.id)] ?? null;
  }

  /** Same rule as the list: the newer login wins, and the answer is the one
   * kept. Only apps on the list have one. */
  setSession(input: Record<string, unknown>): HostWebAppSession | null {
    const id = appId(input.id);
    if (!this.state.apps.some((app) => app.id === id)) throw new Error("Unknown web app");
    const next = { cookies: cookies(input.cookies), updatedAt: stamp(input.updatedAt) };
    const kept = this.sessions[id];
    if (kept && next.updatedAt <= kept.updatedAt) return kept;
    this.sessions[id] = next;
    this.save();
    return next;
  }
}
