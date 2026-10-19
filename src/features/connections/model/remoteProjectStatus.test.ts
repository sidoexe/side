import { describe, expect, it } from "vitest";
import { remoteProjectStatus, remoteReviewAgents } from "./connections";
import type { HostSessionSummary } from "./protocol";

const summary = (patch: Partial<HostSessionSummary>): HostSessionSummary =>
  ({
    id: crypto.randomUUID(),
    title: "",
    harness: "claude",
    status: "idle",
    updatedAt: 0,
    revision: 0,
    ...patch,
  }) as HostSessionSummary;

describe("remote project status", () => {
  it("counts running and to-check sessions, leaving archived ones out", () => {
    expect(
      remoteProjectStatus([
        summary({ status: "running" }),
        summary({ status: "running", archived: true }),
        summary({ toReview: true }),
        summary({ toReview: true }),
        summary({ toReview: true, archived: true }),
        summary({}),
      ]),
    ).toEqual({ working: 1, done: 2 });
  });

  it("counts a session that works again as working, not done", () => {
    expect(
      remoteProjectStatus([summary({ status: "running", toReview: true })]),
    ).toEqual({ working: 1, done: 0 });
  });

  it("counts a session waiting on the user as waiting, not done", () => {
    expect(
      remoteProjectStatus([summary({ toReview: true, needsInput: true })]),
    ).toEqual({ working: 0, done: 0 });
  });
});

describe("remote review rows", () => {
  it("lists sessions asking for input first, then finished ones, newest first", () => {
    const rows = remoteReviewAgents("remote://box/app", [
      summary({ id: "old", title: "Old", toReview: true, updatedAt: 1 }),
      summary({ id: "new", title: "New", toReview: true, updatedAt: 3 }),
      summary({ id: "ask", title: "Ask", needsInput: true, updatedAt: 2 }),
      summary({ id: "busy", status: "running", toReview: true }),
      summary({ id: "gone", toReview: true, archived: true }),
      summary({ id: "seen" }),
    ]);

    expect(rows.map((row) => row.id)).toEqual(["ask", "new", "old"]);
    expect(rows[0]).toMatchObject({
      cwd: "remote://box/app",
      activity: "Needs input",
      needsApproval: true,
      done: false,
    });
    expect(rows[1]).toMatchObject({ activity: "Done", done: true });
  });

  it("puts a failed turn after those asking for input and before finished ones", () => {
    const rows = remoteReviewAgents("remote://box/app", [
      summary({ id: "done", toReview: true, updatedAt: 3 }),
      summary({ id: "failed", toReview: true, failed: true, updatedAt: 1 }),
      summary({ id: "ask", needsInput: true, failed: true, updatedAt: 2 }),
    ]);

    expect(rows.map((row) => row.id)).toEqual(["ask", "failed", "done"]);
    expect(rows[0]).toMatchObject({ activity: "Needs input", failed: false });
    expect(rows[1]).toMatchObject({ activity: "Failed", done: true, failed: true });
  });
});
