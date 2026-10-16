import { describe, expect, it } from "vitest";
import { remoteProjectStatus } from "./connections";
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
});
