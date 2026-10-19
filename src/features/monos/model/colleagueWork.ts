import { useSyncExternalStore } from "react";
import type { MonoSpawnedSession } from "../../sessions/model/session";
import type { LaunchedSessionState } from "./monoSpawnedSessions";

/**
 * The sessions each colleague started, kept apart from its chats so they can
 * be followed without scrolling back: what still runs, what waits on the
 * user, and what settled since the user last looked at the colleague. A
 * session that needs input is answered in that session; the colleague's own
 * chat never takes it over.
 */
export type ColleagueWorkItem = MonoSpawnedSession & {
  /** The colleague's conversation that started it. */
  thread: string;
  /** When it was first seen. */
  at: number;
  state: LaunchedSessionState;
  /** What it is doing, or the call it is waiting for. */
  activity?: string;
  /** When it last stopped working. */
  settledAt?: number;
  /** When a window last saw it running, refreshed every few minutes. */
  liveAt?: number;
  /** A habit's run: listed while it works or waits, gone once it ends,
   * since the habit reports in the chat. */
  habit?: true;
};

/** A session one of the colleague's conversations or habits started. */
export type ColleagueLaunch = {
  launch: MonoSpawnedSession;
  thread: string;
  habit?: boolean;
};

type Entry = { seenAt?: number; items: ColleagueWorkItem[] };
type Store = Record<string, Entry>;

/** What one pass knows of a launch that is open in this window. */
export type LiveLaunch = {
  state: LaunchedSessionState;
  title: string;
  activity?: string;
};

const KEY = "side.colleagueWork.v1";
const CHANGED = "side:colleague-work";
/** Per colleague; the oldest settled ones go first. */
const ITEMS_MAX = 60;
/** How often a window running a session says so. */
const LIVE_REFRESH_MS = 2 * 60_000;
/** Running, but no window has said so in this long: it ended unseen, such
 * as when the app quit. */
export const LIVE_STALE_MS = 10 * 60_000;

export function isActiveWork(state: LaunchedSessionState): boolean {
  return state === "working" || state === "input";
}

function read(): Store {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Store)
      : {};
  } catch {
    return {};
  }
}

function write(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    return;
  }
  cached = undefined;
  window.dispatchEvent(new CustomEvent(CHANGED));
}

/**
 * The colleague's items after one window's look at its launches and the
 * sessions it has open. Another window may run the rest, so one not open here
 * stops counting as running only once `gone` says this window saw it go, or
 * no window has seen it running for a while.
 */
export function mergeColleagueWork(
  items: readonly ColleagueWorkItem[],
  launches: readonly ColleagueLaunch[],
  live: ReadonlyMap<string, LiveLaunch>,
  now: number,
  gone: (sessionId: string) => boolean = () => false,
): ColleagueWorkItem[] {
  const byId = new Map(items.map((item) => [item.sessionId, item]));
  for (const { launch, thread, habit } of launches) {
    if (byId.has(launch.sessionId)) continue;
    const seen = live.get(launch.sessionId);
    // Found already settled in an older chat: history, not news.
    byId.set(launch.sessionId, {
      ...launch,
      thread,
      at: now,
      state: seen?.state ?? "done",
      ...(seen ? { title: seen.title || launch.title } : {}),
      ...(seen?.activity ? { activity: seen.activity } : {}),
      ...(habit ? { habit: true as const } : {}),
    });
  }
  const next = [...byId.values()].map((item): ColleagueWorkItem => {
    const seen = live.get(item.sessionId);
    const stale = now - (item.liveAt ?? item.at) > LIVE_STALE_MS;
    const state =
      seen?.state ??
      (isActiveWork(item.state) && (gone(item.sessionId) || stale)
        ? "done"
        : item.state);
    const { activity, settledAt, liveAt, ...rest } = item;
    const refreshed = !isActiveWork(state)
      ? undefined
      : seen
        ? liveAt && now - liveAt < LIVE_REFRESH_MS
          ? liveAt
          : now
        : liveAt;
    const settled =
      isActiveWork(state)
        ? undefined
        : isActiveWork(item.state)
          ? now
          : settledAt;
    return {
      ...rest,
      title: seen?.title || item.title,
      state,
      // Kept while it runs, until the session says what it does now.
      ...(isActiveWork(state) && (seen ? seen.activity : activity)
        ? { activity: seen ? seen.activity : activity }
        : {}),
      ...(settled ? { settledAt: settled } : {}),
      ...(refreshed ? { liveAt: refreshed } : {}),
    };
  }).filter((item) => !item.habit || isActiveWork(item.state));
  if (next.length <= ITEMS_MAX) return next;
  const recency = (item: ColleagueWorkItem) =>
    isActiveWork(item.state) ? Infinity : (item.settledAt ?? item.at);
  const kept = new Set(
    [...next]
      .sort((a, b) => recency(b) - recency(a))
      .slice(0, ITEMS_MAX)
      .map((item) => item.sessionId),
  );
  return next.filter((item) => kept.has(item.sessionId));
}

/** Records a pass; writes only when something changed. */
export function recordColleagueWork(
  monoId: string,
  launches: readonly ColleagueLaunch[],
  live: ReadonlyMap<string, LiveLaunch>,
  now = Date.now(),
  gone?: (sessionId: string) => boolean,
): void {
  const store = read();
  const entry = store[monoId] ?? { items: [] };
  const items = mergeColleagueWork(entry.items, launches, live, now, gone);
  if (JSON.stringify(items) === JSON.stringify(entry.items)) return;
  write({ ...store, [monoId]: { ...entry, items } });
}

/** The user looked at the colleague: what settled until now is no longer news. */
export function markColleagueSeen(monoId: string, now = Date.now()): void {
  const store = read();
  write({
    ...store,
    [monoId]: { items: store[monoId]?.items ?? [], seenAt: now },
  });
}

export function forgetColleagueWork(monoId: string): void {
  const store = read();
  if (!(monoId in store)) return;
  delete store[monoId];
  write(store);
}

let cached: { text: string; store: Store } | undefined;

function snapshot(): Store {
  let text = "{}";
  try {
    text = localStorage.getItem(KEY) ?? "{}";
  } catch {
    // Unreadable storage reads as nothing tracked.
  }
  if (cached?.text !== text) cached = { text, store: read() };
  return cached.store;
}

function subscribe(onChange: () => void): () => void {
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

/** Every colleague's tracked work, kept in step with storage. */
export function useColleagueWork(): Readonly<Store> {
  return useSyncExternalStore(subscribe, snapshot);
}

export function colleagueWorkStore(): Readonly<Store> {
  return snapshot();
}

export type ColleagueWorkSummary = {
  input: number;
  working: number;
  /** Settled since the last visit, by how. */
  done: number;
  failed: number;
  stopped: number;
};

function settledSince(item: ColleagueWorkItem, seenAt?: number): boolean {
  return (
    !isActiveWork(item.state) &&
    item.state !== "draft" &&
    !!item.settledAt &&
    item.settledAt > (seenAt ?? 0)
  );
}

export function colleagueWorkSummary(
  items: readonly ColleagueWorkItem[],
  seenAt?: number,
): ColleagueWorkSummary {
  const summary = { input: 0, working: 0, done: 0, failed: 0, stopped: 0 };
  for (const item of items) {
    if (item.state === "input") summary.input++;
    else if (item.state === "working") summary.working++;
    else if (settledSince(item, seenAt)) {
      if (item.state === "failed") summary.failed++;
      else if (item.state === "stopped") summary.stopped++;
      else summary.done++;
    }
  }
  return summary;
}

/**
 * What to keep in sight: sessions waiting on the user, then the ones
 * running, then the ones that settled since the last visit, newest first.
 */
export function pinnedColleagueWork(
  items: readonly ColleagueWorkItem[],
  seenAt?: number,
): ColleagueWorkItem[] {
  const rank = (item: ColleagueWorkItem) =>
    item.state === "input" ? 0 : item.state === "working" ? 1 : 2;
  return items
    .filter((item) => isActiveWork(item.state) || settledSince(item, seenAt))
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (b.settledAt ?? b.at) - (a.settledAt ?? a.at),
    );
}

/** "Since your last visit: 3 done · 1 failed", or nothing when none settled. */
export function sinceLastVisitLine(summary: ColleagueWorkSummary): string {
  const parts = [
    summary.done ? `${summary.done} done` : "",
    summary.failed ? `${summary.failed} failed` : "",
    summary.stopped ? `${summary.stopped} stopped` : "",
  ].filter(Boolean);
  return parts.length ? `Since your last visit: ${parts.join(" · ")}` : "";
}

/** "1 needs input · 2 working", or nothing when none runs. */
export function activeWorkLine(summary: ColleagueWorkSummary): string {
  return [
    summary.input ? `${summary.input} needs input` : "",
    summary.working ? `${summary.working} working` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** What the phone gets per colleague: its pinned work, bounded. */
export type PublishedWorkItem = {
  sessionId: string;
  title: string;
  cwd: string;
  harness: string;
  state: LaunchedSessionState;
  activity?: string;
  at: number;
  settledAt?: number;
};

const PUBLISHED_MAX = 12;

/**
 * The phone keeps its own last visit, so it gets the running ones and the
 * most recent settled ones, not only what is news on this desktop.
 */
export function publishedColleagueWork(
  store: Readonly<Store>,
  monoIds: readonly string[],
): Record<string, PublishedWorkItem[]> {
  return Object.fromEntries(
    monoIds.flatMap((id) => {
      const items = store[id]?.items ?? [];
      if (!items.length) return [];
      const shown = pinnedColleagueWork(items, -1)
        .filter((item) => item.state !== "draft")
        .slice(0, PUBLISHED_MAX)
        .map((item) => ({
          sessionId: item.sessionId,
          title: item.title.slice(0, 120),
          cwd: item.cwd,
          harness: item.harness,
          state: item.state,
          ...(item.activity ? { activity: item.activity.slice(0, 120) } : {}),
          at: item.at,
          ...(item.settledAt ? { settledAt: item.settledAt } : {}),
        }));
      return shown.length ? [[id, shown]] : [];
    }),
  );
}
