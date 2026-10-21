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

describe("searchRemoteSessions", () => {
  it("asks every machine's host and opens its hits on that host", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const { searchRemoteSessions, parseRemoteNotificationId } = await import("./connections");
    vi.mocked(invoke).mockImplementation(async (command, input) => {
      if (command === "remote_machines")
        return [
          { id: "work", name: "Work", endpoint: "ssh://work", environmentId: "env-work" },
          { id: "old", name: "Old", endpoint: "ssh://old", environmentId: "env-old" },
        ];
      const { machineId, method } = input as { machineId: string; method: string };
      if (method !== "sessions.search") return undefined;
      if (machineId === "old") throw new Error("Unknown method");
      return {
        truncated: false,
        hits: [{ kind: "message", sessionId: "s1", cwd: "/home/me/repo", harness: "codex", title: "Fix", updatedAt: 2, blockId: "b", role: "assistant", preview: "login fixed" }],
      };
    });
    const result = await searchRemoteSessions("login");
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].cwd).toBe("remote://env-work/home/me/repo");
    expect(parseRemoteNotificationId(result.hits[0].sessionId)).toEqual({ project: "remote://env-work/home/me/repo", sessionId: "s1" });
  });
});
