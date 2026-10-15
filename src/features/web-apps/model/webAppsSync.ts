import { invoke } from "@tauri-apps/api/core";
import { remoteRequest } from "../../connections/model/connections";
import { machineCapabilities } from "../../connections/model/homeCapability";
import type { RemoteMachine } from "../../connections/model/protocol";
import {
  adoptWebApps,
  loadWebApps,
  webAppsUpdatedAt,
  type WebApp,
} from "./webApps";

type HostList = { apps: WebApp[]; updatedAt: number };
type HostSession = { cookies: string[]; updatedAt: number } | null;

/** What this desktop last sent or took for an app's login. */
export type SessionMark = {
  updatedAt: number;
  /** Digest of the cookie names: a change there is a sign-in or sign-out. */
  names: string;
  /** Digest of names and values: tokens refresh without signing anyone in. */
  values: string;
  sentAt: number;
};

const SESSIONS_KEY = "monocode.webApps.sessions";
/** Refreshed tokens are shared at most this often; sign-ins go at once. */
const VALUE_PUSH_MS = 5 * 60_000;

function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** A cookie's `name=value`, ahead of its attributes. */
function pair(cookie: string): string {
  return cookie.split(";", 1)[0].trim();
}

export function cookieDigest(cookies: string[]): { names: string; values: string } {
  const pairs = cookies.map(pair).sort();
  return {
    names: hash(pairs.map((p) => p.split("=", 1)[0]).join("\n")),
    values: hash(pairs.join("\n")),
  };
}

/** Whether this desktop's cookies are news for the hosts. */
export function shouldShare(
  mark: SessionMark | undefined,
  digest: { names: string; values: string },
  now: number,
): boolean {
  if (!mark) return true;
  if (mark.names !== digest.names) return true;
  return mark.values !== digest.values && now - mark.sentAt >= VALUE_PUSH_MS;
}

function loadMarks(): Record<string, SessionMark> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SESSIONS_KEY) ?? "");
    return value && typeof value === "object"
      ? (value as Record<string, SessionMark>)
      : {};
  } catch {
    return {};
  }
}

function saveMarks(marks: Record<string, SessionMark>) {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(marks));
  } catch {
    // private mode / quota
  }
}

async function webAppHosts(machines: RemoteMachine[]): Promise<RemoteMachine[]> {
  const capable = await Promise.all(
    machines.map((machine) =>
      machineCapabilities(machine)
        .then((caps) => caps.includes("webApps"))
        .catch(() => false),
    ),
  );
  return machines.filter((_, index) => capable[index]);
}

/** Each host keeps the newest list; whichever is newer, ours or a host's,
 * ends up on both. Apps another desktop removed are signed out here too. */
async function syncList(hosts: RemoteMachine[]) {
  // A list never edited since syncing existed still beats an empty host.
  let local: HostList = { apps: loadWebApps(), updatedAt: webAppsUpdatedAt() || 1 };
  for (const host of hosts) {
    const kept = await remoteRequest<HostList>(host.id, "webApps.set", local);
    if (kept.updatedAt <= local.updatedAt) continue;
    const ids = new Set(kept.apps.map((app) => app.id));
    for (const app of local.apps)
      if (!ids.has(app.id))
        void invoke("web_embed_forget", { app: app.id }).catch(() => {});
    adoptWebApps(kept.apps, kept.updatedAt);
    local = kept;
  }
}

/** Logins go both ways: a newer one on a host signs this desktop in, and a
 * sign-in here reaches the hosts. Only open apps have cookies to read. */
async function syncSessions(hosts: RemoteMachine[]) {
  const marks = loadMarks();
  for (const app of loadWebApps()) {
    let mark = marks[app.id];
    for (const host of hosts) {
      const kept = await remoteRequest<HostSession>(host.id, "webApps.session", { id: app.id });
      if (!kept || kept.updatedAt <= (mark?.updatedAt ?? 0)) continue;
      const digest = cookieDigest(kept.cookies);
      await invoke("web_embed_set_cookies", {
        app: app.id,
        cookies: kept.cookies,
        reload: digest.names !== mark?.names,
      });
      mark = { updatedAt: kept.updatedAt, ...digest, sentAt: Date.now() };
    }
    const cookies = await invoke<string[] | null>("web_embed_cookies", { app: app.id });
    const now = Date.now();
    if (cookies?.length) {
      const digest = cookieDigest(cookies);
      if (shouldShare(mark, digest, now)) {
        const updatedAt = Math.max(now, (mark?.updatedAt ?? 0) + 1);
        for (const host of hosts)
          await remoteRequest(host.id, "webApps.setSession", { id: app.id, cookies, updatedAt });
        mark = { updatedAt, ...digest, sentAt: now };
      }
    }
    if (mark) marks[app.id] = mark;
  }
  const ids = new Set(loadWebApps().map((app) => app.id));
  for (const id of Object.keys(marks)) if (!ids.has(id)) delete marks[id];
  saveMarks(marks);
}

/** One round with every connected host that keeps web apps; an old host or a
 * failed request just waits for the next round. */
export async function syncWebApps(machines: RemoteMachine[]): Promise<void> {
  const hosts = await webAppHosts(machines);
  if (hosts.length === 0) return;
  try {
    await syncList(hosts);
    await syncSessions(hosts);
  } catch {
    /* tried again on the next change or check */
  }
}
