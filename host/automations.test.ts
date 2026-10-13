import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostAutomations } from "./automations";

const opened: Array<{ root: string; store: HostAutomations }> = [];
afterEach(() => {
  for (const { root, store } of opened.splice(0)) {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function automations() {
  const root = mkdtempSync(join(tmpdir(), "side-automations-"));
  const store = new HostAutomations(join(root, "automations.db"));
  opened.push({ root, store });
  return store;
}

const NOW = 1_800_000_000_000;
const draft = (overrides: Record<string, unknown> = {}) => ({
  id: "auto-1",
  name: " Audit ",
  prompt: "Review the repository",
  harness: "claude",
  model: "claude:opus",
  modelSettings: {},
  cwd: "remote://env/Users/me/app",
  workspaceMode: "current",
  worktreeCwd: "ignored",
  sessionFolderId: "",
  reuseSession: false,
  runtimeMode: "auto",
  triggerKind: "time",
  triggerEvent: "",
  scheduleKind: "daily",
  minute: 0,
  time: "09:00",
  dayOfWeek: 1,
  triggers: [
    { id: "t1", kind: "time", event: "daily", scheduleKind: "daily", minute: 0, time: "09:00", dayOfWeek: 1 },
    { id: "t2", kind: "github", event: "pull_request_opened", repos: [" a/b ", ""] },
  ],
  missedRunGraceMinutes: 60,
  enabled: true,
  nextRunAt: NOW + 1_000,
  ...overrides,
});

it("saves, lists and deletes automations with normalized triggers", () => {
  const store = automations();
  const saved = store.upsert(draft(), NOW);
  expect(saved).toMatchObject({ name: "Audit", worktreeCwd: "", createdAt: NOW });
  expect(saved.triggers[1]).toMatchObject({ actor: "anyone", repos: ["a/b"] });
  expect(store.list().map((automation) => automation.id)).toEqual(["auto-1"]);
  expect(() => store.upsert(draft({ nextRunAt: NOW - 1 }), NOW)).toThrow("must be in the future");
  expect(() => store.upsert(draft({ runtimeMode: "root" }), NOW)).toThrow("run mode");
  expect(() => store.upsert(draft({ time: "9:00" }), NOW)).toThrow("time");
  store.delete("auto-1");
  expect(store.list()).toEqual([]);
});

it("hands a due occurrence to exactly one desktop", () => {
  const store = automations();
  store.upsert(draft(), NOW);
  const claim = (device: string) =>
    store.claimDue({ automationId: "auto-1", expectedNextRunAt: NOW + 1_000, nextRunAt: NOW + 86_401_000, now: NOW + 2_000 }, device);
  const first = claim("pro");
  expect(first?.run).toMatchObject({ status: "pending", trigger: "scheduled", claimedBy: "pro" });
  expect(first?.automation.nextRunAt).toBe(NOW + 86_401_000);
  expect(claim("air")).toBeNull();
  expect(store.list()[0]).toMatchObject({ nextRunAt: NOW + 86_401_000, lastRunStatus: "pending" });
  // Not due yet.
  expect(store.claimDue({ automationId: "auto-1", expectedNextRunAt: NOW + 86_401_000, nextRunAt: NOW + 2 * 86_401_000, now: NOW }, "air")).toBeNull();
});

it("skips an occurrence missed beyond its grace period", () => {
  const store = automations();
  store.upsert(draft(), NOW);
  const late = store.claimDue({ automationId: "auto-1", expectedNextRunAt: NOW + 1_000, nextRunAt: NOW + 9e7, now: NOW + 1_000 + 61 * 60_000 }, "pro");
  expect(late?.run).toMatchObject({ status: "skipped", error: expect.stringContaining("grace") });
});

it("claims one Inbox event once for one automation", () => {
  const store = automations();
  store.upsert(draft(), NOW);
  const claim = (device: string, event = "pull_request_opened") =>
    store.claimEvent({
      automationId: "auto-1",
      claim: { eventKey: "github:a/b:1", eventKind: "github", event, scheduledFor: 0, prompt: "Review PR 1" },
      now: NOW,
    }, device);
  expect(claim("pro", "issue_opened")).toBeNull();
  expect(claim("pro")?.run).toMatchObject({ trigger: "event", eventKey: "github:a/b:1", scheduledFor: NOW });
  expect(claim("air")).toBeNull();
});

it("recovers only the restarting desktop's own runs", () => {
  const store = automations();
  store.upsert(draft(), NOW);
  const mine = store.runNow("auto-1", NOW, "pro");
  const running = store.runNow("auto-1", NOW + 1, "pro");
  store.updateRun({ runId: running.id, status: "running", sessionId: "session-1", now: NOW + 2 });
  const theirs = store.runNow("auto-1", NOW + 3, "air");
  const due = store.recover(NOW + 10, NOW + 20, "pro");
  expect(due.map((item) => item.run.id)).toEqual([mine.id]);
  const runs = store.runs("auto-1");
  expect(runs.find((run) => run.id === running.id)).toMatchObject({ status: "cancelled", completedAt: NOW + 20 });
  expect(runs.find((run) => run.id === theirs.id)?.status).toBe("pending");
  expect(runs.every((run) => !("prompt" in run))).toBe(true);
  expect(store.list()[0].lastSessionId).toBe("session-1");
});

it("records a run's outcome on its automation", () => {
  const store = automations();
  store.upsert(draft(), NOW);
  const run = store.runNow("auto-1", NOW, "pro");
  store.updateRun({ runId: run.id, status: "running", sessionId: "s", now: NOW + 1 });
  const done = store.updateRun({ runId: run.id, status: "failed", error: "Boom", now: NOW + 2 });
  expect(done).toMatchObject({ startedAt: NOW + 1, completedAt: NOW + 2, error: "Boom" });
  expect(store.list()[0]).toMatchObject({ lastRunStatus: "failed", lastRunError: "Boom", lastSessionId: "s" });
  expect(() => store.updateRun({ runId: run.id, status: "exploded", now: NOW })).toThrow("status");
});

it("imports a desktop's automation as it was, keeping one the host already has", () => {
  const store = automations();
  const imported = store.upsert(draft({ nextRunAt: NOW - 5, createdAt: 7, lastRunStatus: "succeeded" }), NOW, true);
  expect(imported).toMatchObject({ nextRunAt: NOW - 5, createdAt: 7, lastRunStatus: "succeeded" });
  expect(store.upsert(draft({ name: "Other" }), NOW, true).name).toBe("Audit");
});

it("keeps the newest hundred finished runs", () => {
  const store = automations();
  store.upsert(draft(), NOW);
  for (let index = 0; index < 105; index++) {
    const run = store.runNow("auto-1", NOW + index, "pro");
    store.updateRun({ runId: run.id, status: "succeeded", now: NOW + index });
  }
  expect(store.runs("auto-1")).toHaveLength(100);
});
