import type { HarnessId } from "./session";

/**
 * Sessions the user marked checked, last checked first, so the rail can show
 * what got closed out. Each keeps what its row needs, since a checked session
 * is usually no longer loaded. Only the latest ones are kept.
 */

export type CheckedSession = {
  id: string;
  cwd: string;
  title: string;
  harness: HarnessId;
};

const KEY = "monocode.sessionsChecked";
const CHANGED = "monocode:sessions-checked-changed";
const LIMIT = 50;
const EMPTY: readonly CheckedSession[] = [];

let cache: { raw: string | null; value: readonly CheckedSession[] } | null =
  null;

function readRaw(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function isEntry(value: unknown): value is CheckedSession {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.cwd === "string" &&
    typeof entry.title === "string" &&
    typeof entry.harness === "string"
  );
}

function parse(raw: string | null): readonly CheckedSession[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "");
    return Array.isArray(parsed) ? parsed.filter(isEntry) : EMPTY;
  } catch {
    return EMPTY;
  }
}

/** Last checked first. Stable while nothing changes. */
export function checkedSessions(): readonly CheckedSession[] {
  const raw = readRaw();
  if (cache?.raw !== raw) cache = { raw, value: parse(raw) };
  return cache.value;
}

export function subscribeCheckedSessions(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) onChange();
  };
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function save(next: readonly CheckedSession[]) {
  const raw = JSON.stringify(next);
  cache = { raw, value: next };
  try {
    localStorage.setItem(KEY, raw);
  } catch {
    // private mode / quota
  }
  window.dispatchEvent(new Event(CHANGED));
}

/** The user marked these sessions checked; a later check moves one to the top. */
export function noteSessionsChecked(sessions: Iterable<CheckedSession>) {
  const added = [...sessions];
  if (added.length === 0) return;
  const ids = new Set(added.map((entry) => entry.id));
  save(
    [
      ...added,
      ...checkedSessions().filter((entry) => !ids.has(entry.id)),
    ].slice(0, LIMIT),
  );
}

/** These sessions were archived or deleted. */
export function forgetCheckedSessions(ids: Iterable<string>) {
  const gone = new Set(ids);
  const current = checkedSessions();
  const next = current.filter((entry) => !gone.has(entry.id));
  if (next.length !== current.length) save(next);
}
