import { beforeEach, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
const machines = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock("./connections", () => ({
  remoteMachineFor: async (environmentId: string) =>
    machines.list.find((machine: any) => machine.environmentId === environmentId),
  remoteRequest: async () => ({ platform: "win32" }),
}));

import { spawnRemotePty } from "./remoteTerminals";
import { remoteTerminalCwd } from "./remoteProjects";
import { spawnPty } from "../../../platform/tauri/pty";

beforeEach(() => {
  invoke.mockReset();
  machines.list = [];
});

it("opens a terminal on the machine that owns the folder", async () => {
  machines.list = [{ id: "m1", environmentId: "env", ssh: { target: "me@pc", remotePort: 3774 } }];
  await spawnPty("t1", "remote://env/C:/Users/me/app", 80, 24);
  expect(invoke).toHaveBeenCalledWith("pty_spawn_remote", {
    id: "t1", machineId: "m1", cwd: "C:/Users/me/app", windows: true, cols: 80, rows: 24,
  });
  await spawnPty("t2", "/Users/me/local", 80, 24);
  expect(invoke).toHaveBeenLastCalledWith("pty_spawn", { id: "t2", cwd: "/Users/me/local", cols: 80, rows: 24 });
});

it("explains why a machine without SSH cannot open one", async () => {
  machines.list = [{ id: "m1", environmentId: "env", ssh: null }];
  await expect(spawnRemotePty("t", "remote://env/home/me", 80, 24)).rejects.toThrow("SSH");
  await expect(spawnRemotePty("t", "remote://other/home/me", 80, 24)).rejects.toThrow("Connect");
});

it("keeps folders a remote shell reports on its machine", () => {
  expect(remoteTerminalCwd("remote://env/home/me", "/home/me/src")).toBe("remote://env/home/me/src");
  expect(remoteTerminalCwd("/Users/me", "/Users/me/src")).toBe("/Users/me/src");
});
