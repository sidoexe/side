import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { setRemoteWaitingCount, syncDockBadge } from "./dockBadge";
import type { Session } from "../../sessions/model/session";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

const waiting = (cwd: string): Session =>
  ({ id: cwd, cwd, harness: "codex", title: "", blocks: [], pendingQuestion: { requestId: 1, questions: [] } }) as unknown as Session;

beforeEach(() => vi.mocked(invoke).mockClear());

it("counts host sessions from their hosts, once, beside local ones", () => {
  setRemoteWaitingCount(0);
  syncDockBadge([waiting("/repo"), waiting("remote://env/home/me/repo")]);
  // The open host tab is not counted twice: its host's list counts it.
  expect(invoke).toHaveBeenLastCalledWith("set_dock_badge", { count: 1 });
  setRemoteWaitingCount(2);
  expect(invoke).toHaveBeenLastCalledWith("set_dock_badge", { count: 3 });
});
