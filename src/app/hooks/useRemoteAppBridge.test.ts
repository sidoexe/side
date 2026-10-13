import { expect, it, vi } from "vitest";
import { relayAppCalls } from "./useRemoteAppBridge";
import { newDefaultSession, type Session } from "../../features/sessions/model/session";
import {
  answerToHostPaths,
  callToDesktopPaths,
} from "../../features/connections/model/remoteAppCalls";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const machine = { id: "m1", name: "Pro", endpoint: "", environmentId: "env" };
const session = (busy: boolean, cwd = "remote://env/Users/me/app"): Session => ({
  ...newDefaultSession(cwd),
  id: busy ? "shell-busy" : "shell-idle",
  busy,
});

it("maps an agent's folders to the desktop's and its answers back", () => {
  expect(callToDesktopPaths({ cwd: "/Users/me/app", worktreeCwd: "C:\\w", prompt: "/etc" }, "env")).toEqual({
    cwd: "remote://env/Users/me/app",
    worktreeCwd: "remote://env/C:/w",
    prompt: "/etc",
  });
  expect(callToDesktopPaths({ cwd: "remote://env/x" }, "env")).toEqual({ cwd: "remote://env/x" });
  expect(answerToHostPaths({ sessions: [{ cwd: "remote://env/Users/me/app", title: "remote://other/x" }] }, "env"))
    .toEqual({ sessions: [{ cwd: "/Users/me/app", title: "remote://other/x" }] });
});

it("runs the calls waiting on a busy host session and replies to each", async () => {
  const requests: Array<{ method: string; params: any }> = [];
  const run = vi.fn(async (payload: any) => {
    if (payload.action === "boom") throw new Error("No such action");
    return { cwd: payload.input.cwd };
  });
  await relayAppCalls([session(true), session(false)], run, {
    machineFor: (environmentId) => (environmentId === "env" ? machine : undefined),
    hostSessionFor: (shellId) => (shellId === "shell-busy" ? "host-1" : "host-2"),
    capabilities: async () => ["app"],
    request: async <T,>(_machine: string, method: string, params: any): Promise<T> => {
      requests.push({ method, params });
      if (method === "app.take")
        return [
          { id: "c1", sessionId: "host-1", requestId: "r1", action: "sessions.list", input: { cwd: "/Users/me/app" } },
          { id: "c2", sessionId: "host-1", requestId: "r2", action: "boom", input: {} },
        ] as T;
      return { delivered: true } as T;
    },
  });
  expect(run.mock.calls[0][0]).toMatchObject({
    namespace: "app", sessionId: "shell-busy", requestId: "r1", input: { cwd: "remote://env/Users/me/app" },
  });
  expect(requests).toEqual([
    { method: "app.take", params: { sessionId: "host-1" } },
    { method: "app.reply", params: { id: "c1", response: { ok: true, result: { cwd: "/Users/me/app" } } } },
    { method: "app.reply", params: { id: "c2", response: { ok: false, error: "No such action" } } },
  ]);
});

it("leaves hosts that do not relay app calls alone", async () => {
  const request = vi.fn();
  await relayAppCalls([session(true)], vi.fn(), {
    machineFor: () => machine,
    hostSessionFor: () => "host-1",
    capabilities: async () => ["sessions"],
    request,
  });
  expect(request).not.toHaveBeenCalled();
});
