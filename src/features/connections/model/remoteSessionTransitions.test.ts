import { describe, expect, it, vi } from "vitest";
import { remoteSessionTransitions } from "./connections";
import type { HostSessionSummary } from "./protocol";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("remoteSessionTransitions", () => {
  const summary = (patch: Partial<HostSessionSummary>): HostSessionSummary =>
    ({ id: "s", projectId: "p", title: "Work", harness: "codex", status: "idle", revision: 1, updatedAt: 1, ...patch }) as HostSessionSummary;
  const project = "remote://env/home/me/repo";

  it("announces a turn that ended and a session that waits on the user", () => {
    expect(remoteSessionTransitions(project, [summary({ status: "running" })], [summary({ status: "idle", toReview: true })])).toEqual([
      { project, session: summary({ status: "idle", toReview: true }), kind: "finished" },
    ]);
    expect(remoteSessionTransitions(project, [summary({ status: "running" })], [summary({ status: "running", needsInput: true })])).toMatchObject([
      { kind: "input" },
    ]);
  });

  it("says nothing when nothing changed, on a first reading, or for an archived session", () => {
    expect(remoteSessionTransitions(project, [summary({ status: "running" })], [summary({ status: "running" })])).toEqual([]);
    expect(remoteSessionTransitions(project, [], [summary({ status: "idle" })])).toEqual([]);
    expect(remoteSessionTransitions(project, [summary({ status: "running" })], [summary({ status: "idle", archived: true })])).toEqual([]);
  });
});
