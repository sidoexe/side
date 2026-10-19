// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import type { MonoSpawnedSession } from "../../sessions/model/session";
import {
  activeWorkLine,
  colleagueLiveAgents,
  colleagueOfSession,
  colleagueWorkStore,
  colleagueWorkSummary,
  forgetColleagueWork,
  LIVE_STALE_MS,
  mergeColleagueWork,
  pinnedColleagueWork,
  publishedColleagueWork,
  recordColleagueWork,
  toReviewLine,
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
  expect(pinnedColleagueWork(items, new Set())).toEqual([]);
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

it("pins what waits on the user first, then what runs, then what waits to be checked", () => {
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
  const toReview = new Set(["new-done", "new-fail"]);
  expect(pinnedColleagueWork(items, toReview).map((entry) => entry.sessionId)).toEqual([
    "ask",
    "run",
    "new-fail",
    "new-done",
  ]);
  const summary = colleagueWorkSummary(items, toReview);
  expect(summary).toEqual({ input: 1, working: 1, done: 1, failed: 1, stopped: 0 });
  expect(toReviewLine(summary)).toBe("To review: 1 done · 1 failed");
  expect(activeWorkLine(summary)).toBe("1 needs input · 1 working");
  // Checked: it leaves the colleague's list as it leaves To review.
  expect(toReviewLine(colleagueWorkSummary(items, new Set()))).toBe("");
});

it("stores each colleague's work and forgets a deleted colleague", () => {
  recordColleagueWork("m", [{ launch: launch("a"), thread: "t" }], live([["a", { state: "working", title: "A" }]]), 1);
  expect(colleagueWorkStore().m).toMatchObject({ items: [{ sessionId: "a", state: "working" }] });
  forgetColleagueWork("m");
  expect(colleagueWorkStore().m).toBeUndefined();
});

it("publishes what runs and what recently ended, saying what waits to be checked", () => {
  recordColleagueWork("m", [{ launch: launch("a"), thread: "t" }], live([["a", { state: "input", title: "A", activity: "Approve rm" }]]), 1);
  recordColleagueWork("m", [{ launch: launch("old"), thread: "t" }], live([]), 2);
  recordColleagueWork("m", [{ launch: launch("b"), thread: "t" }], live([["b", { state: "working", title: "B" }]]), 3);
  recordColleagueWork("m", [{ launch: launch("b"), thread: "t" }], live([["b", { state: "done", title: "B" }]]), 4);
  expect(publishedColleagueWork(colleagueWorkStore(), ["m", "other"], new Set(["b"]))).toEqual({
    m: [
      { sessionId: "a", title: "A", cwd: "/code/app", harness: "claude", state: "input", activity: "Approve rm", at: 1 },
      { sessionId: "b", title: "B", cwd: "/code/app", harness: "claude", state: "done", at: 3, settledAt: 4, toReview: true },
    ],
  });
});

it("puts a colleague's sessions running out of this window's sight on the board", () => {
  recordColleagueWork("m", [{ launch: launch("a"), thread: "t" }], live([["a", { state: "input", title: "A", activity: "Approve rm" }]]), 1);
  recordColleagueWork("m", [{ launch: launch("b"), thread: "t" }], live([["b", { state: "working", title: "B" }]]), 1);
  recordColleagueWork("m", [{ launch: launch("old"), thread: "t" }], live([]), 1);
  const store = colleagueWorkStore();
  expect(colleagueOfSession(store).get("old")).toBe("m");
  // "b" is already a row of this window's own.
  expect(colleagueLiveAgents(store, [{ id: "m", name: "CTO" }], new Set(["b"]))).toEqual([
    {
      id: "a",
      cwd: "/code/app",
      title: "A",
      harness: "claude",
      activity: "Approve rm",
      needsApproval: true,
      done: false,
      colleague: { id: "m", name: "CTO" },
    },
  ]);
});
