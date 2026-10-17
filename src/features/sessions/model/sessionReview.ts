/**
 * Sessions that finished and wait for the user to check them, with the folder
 * each ran in so a project can count them while they are not loaded. They
 * survive restarts and stay until the user marks them checked or they work
 * again, so looking at one never loses the reminder.
 */

const KEY = "monocode.sessionsToReview";
const CHANGED = "monocode:sessions-to-review-changed";

let cache: { raw: string | null; value: ReadonlyMap<string, string> } | null =
  null;

function readRaw(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function parse(raw: string | null): ReadonlyMap<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw ?? "");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return new Map();
    return new Map(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return new Map();
  }
}

/** Session id → its folder. Stable while nothing changes. */
export function sessionsToReview(): ReadonlyMap<string, string> {
  const raw = readRaw();
  if (cache?.raw !== raw) cache = { raw, value: parse(raw) };
  return cache.value;
}

export function subscribeSessionsToReview(onChange: () => void): () => void {
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

function save(next: ReadonlyMap<string, string>) {
  const raw = JSON.stringify(Object.fromEntries(next));
  cache = { raw, value: next };
  try {
    localStorage.setItem(KEY, raw);
  } catch {
    // private mode / quota
  }
  window.dispatchEvent(new Event(CHANGED));
}

/** Keep exactly `ids`, taking a new one's folder from `cwdOf`. */
export function replaceSessionsToReview(
  ids: ReadonlySet<string>,
  cwdOf: (id: string) => string | undefined,
) {
  const current = sessionsToReview();
  if (current.size === ids.size && [...ids].every((id) => current.has(id)))
    return;
  save(new Map([...ids].map((id) => [id, current.get(id) ?? cwdOf(id) ?? ""])));
}

/** The user checked these sessions, or they no longer exist. */
export function markSessionsReviewed(ids: Iterable<string>) {
  const current = sessionsToReview();
  const next = new Map(current);
  for (const id of ids) next.delete(id);
  if (next.size !== current.size) save(next);
}

/** These sessions wait to be checked, as when a turn finishes. */
export function addSessionsToReview(
  entries: Iterable<{ id: string; cwd: string }>,
) {
  const current = sessionsToReview();
  const next = new Map(current);
  for (const { id, cwd } of entries) if (!next.has(id)) next.set(id, cwd);
  if (next.size !== current.size) save(next);
}

const stoppedByUser = new Set<string>();

/** The user stopped this session's turn: when it settles, it is not done. */
export function noteStoppedByUser(id: string) {
  stoppedByUser.add(id);
}

/** Sessions stopped by the user whose turn has not been seen to settle. */
export function stoppedByUserIds(): ReadonlySet<string> {
  return stoppedByUser;
}

/** Their stop has been accounted for once they stopped working. */
export function forgetStoppedByUser(idleIds: Iterable<string>) {
  for (const id of idleIds) stoppedByUser.delete(id);
}
