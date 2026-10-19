// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import type { MonoSpawnedSession } from "../../sessions/model/session";
import {
  activeWorkLine,
  colleagueWorkStore,
  colleagueWorkSummary,
  forgetColleagueWork,
  LIVE_STALE_MS,
  markColleagueSeen,
  mergeColleagueWork,
  pinnedColleagueWork,
  publishedColleagueWork,
  recordColleagueWork,
  sinceLastVisitLine,
  type ColleagueWorkItem,
  type LiveLaunch,
} from "./colleagueWork";

beforeEach(() => localStorage.clear());

function launch(id: string): MonoSpawnedSession {
  return {
    sessionId: id,
    cwd: "/code/app",
    title: `Task ${id}`,
    harness: "claude",
    model: "claude:x",
  };
}

const live = (entries: [string, LiveLaunch][]) => new Map(entries);

it("follows a launch from running to done, noting when it ended", () => {
  let items = mergeColleagueWork(
    [],
    [{ launch: launch("a"), thread: "t1" }],
    live([["a", { state: "working", title: "Fix CI", activity: "Running tests" }]]),
    1_000,
  );
  expect(items).toMatchObject([
    { sessionId: "a", thread: "t1", state: "working", title: "Fix CI", activity: "Running tests", at: 1_000, liveAt: 1_000 },
  ]);
  expect(items[0].settledAt).toBeUndefined();

  items = mergeColleagueWork(
    items,
    [{ launch: launch("a"), thread: "t1" }],
    live([["a", { state: "done", title: "Fix CI" }]]),
    5_000,
  );
  expect(items[0]).toMatchObject({ state: "done", settledAt: 5_000 });
  expect(items[0].activity).toBeUndefined();
  expect(items[0].liveAt).toBeUndefined();
});

it("treats a launch first found settled in an older chat as history, not news", () => {
  const items = mergeColleagueWork([], [{ launch: launch("old"), thread: "t1" }], live([]), 9_000);
  expect(items[0]).toMatchObject({ state: "done" });
  expect(items[0].settledAt).toBeUndefined();
  expect(pinnedColleagueWork(items, 0)).toEqual([]);
});

it("leaves a session running in another window alone until it goes stale", () => {
  const running: ColleagueWorkItem = {
    ...launch("a"),
    thread: "t1",
    at: 0,
    state: "working",
    liveAt: 0,
  };
  // Not open here, never seen here: another window may run it.
  expect(mergeColleagueWork([running], [], live([]), LIVE_STALE_MS - 1)[0].state).toBe("working");
  // No window has said so for too long: it ended unseen.
  expect(mergeColleagueWork([running], [], live([]), LIVE_STALE_MS + 1)[0]).toMatchObject({
    state: "done",
    settledAt: LIVE_STALE_MS + 1,
  });
  // This window had it and no longer does: it ended here.
  expect(mergeColleagueWork([running], [], live([]), 10, () => true)[0].state).toBe("done");
});

it("lists a habit's run only while it works or waits", () => {
  const habit = { launch: launch("run"), thread: "", habit: true };
  const waiting = mergeColleagueWork([], [habit], live([["run", { state: "input", title: "Morning check", activity: "Approve git push" }]]), 1);
  expect(waiting).toMatchObject([{ sessionId: "run", habit: true, state: "input" }]);
  expect(mergeColleagueWork(waiting, [], live([]), 2, () => true)).toEqual([]);
});

it("pins what waits on the user first, then what runs, then what ended since the last visit", () => {
  const item = (id: string, state: ColleagueWorkItem["state"], settledAt?: number): ColleagueWorkItem => ({
    ...launch(id),
    thread: "t",
    at: 1,
    state,
    ...(settledAt ? { settledAt } : {}),
  });
  const items = [
    item("old-done", "done", 50),
    item("run", "working"),
    item("new-done", "done", 200),
    item("ask", "input"),
    item("new-fail", "failed", 300),
  ];
  expect(pinnedColleagueWork(items, 100).map((entry) => entry.sessionId)).toEqual([
    "ask",
    "run",
    "new-fail",
    "new-done",
  ]);
  const summary = colleagueWorkSummary(items, 100);
  expect(summary).toEqual({ input: 1, working: 1, done: 1, failed: 1, stopped: 0 });
  expect(sinceLastVisitLine(summary)).toBe("Since your last visit: 1 done · 1 failed");
  expect(activeWorkLine(summary)).toBe("1 needs input · 1 working");
  expect(sinceLastVisitLine(colleagueWorkSummary(items, 1_000))).toBe("");
});

it("stores each colleague's work, the last visit, and forgets a deleted colleague", () => {
  recordColleagueWork("m", [{ launch: launch("a"), thread: "t" }], live([["a", { state: "working", title: "A" }]]), 1);
  markColleagueSeen("m", 7);
  expect(colleagueWorkStore().m).toMatchObject({ seenAt: 7, items: [{ sessionId: "a", state: "working" }] });
  forgetColleagueWork("m");
  expect(colleagueWorkStore().m).toBeUndefined();
});

it("publishes what runs and what recently ended, bounded, for the phone", () => {
  recordColleagueWork("m", [{ launch: launch("a"), thread: "t" }], live([["a", { state: "input", title: "A", activity: "Approve rm" }]]), 1);
  recordColleagueWork("m", [{ launch: launch("old"), thread: "t" }], live([]), 2);
  expect(publishedColleagueWork(colleagueWorkStore(), ["m", "other"])).toEqual({
    m: [{ sessionId: "a", title: "A", cwd: "/code/app", harness: "claude", state: "input", activity: "Approve rm", at: 1 }],
  });
});
