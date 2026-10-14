import { expect, it, vi } from "vitest";
import { updateHostIfOlder, type AutoUpdateDeps } from "./hostAutoUpdate";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const machine = {
  id: "pro",
  name: "Pro",
  endpoint: "ssh://sido@pro",
  environmentId: "env-pro",
  ssh: { target: "sido@pro", remotePort: 3775 },
};

function deps({
  version,
  running = false,
  jobs = [{ done: true }],
}: {
  version?: string;
  running?: boolean;
  jobs?: { done: boolean; error?: string; prompt?: unknown }[];
}) {
  const commands: [string, unknown][] = [];
  const value: AutoUpdateDeps = {
    request: (async (_machine: string, method: string) => {
      if (method === "environment.describe")
        return { environmentId: "env-pro", capabilities: [], providers: [], ...(version ? { version } : {}) };
      if (method === "projects.list") return [{ id: "a" }, { id: "b" }];
      if (method === "sessions.list") return [{ status: "idle" }, ...(running ? [{ status: "running" }] : [])];
      throw new Error(method);
    }) as AutoUpdateDeps["request"],
    invoke: (async (command: string, args?: unknown) => {
      commands.push([command, args]);
      if (command === "remote_ssh_reconnect") return "job-1";
      if (command === "remote_ssh_poll") return { id: "job-1", message: "", ...jobs.shift() };
      return undefined;
    }) as AutoUpdateDeps["invoke"],
    sleep: async () => undefined,
  };
  return { value, commands };
}

it("updates an idle host older than this desktop, as Update Host does", async () => {
  const { value, commands } = deps({ version: "0.15.0", jobs: [{ done: false }, { done: true }] });
  await expect(updateHostIfOlder(machine, "0.21.0", value)).resolves.toBe("updated");
  expect(commands[0]).toEqual(["remote_ssh_reconnect", { machineId: "pro", upgrade: true }]);
});

it("treats a host that does not say its version as older", async () => {
  const { value } = deps({});
  await expect(updateHostIfOlder(machine, "0.21.0", value)).resolves.toBe("updated");
});

it("leaves a current host alone", async () => {
  const { value, commands } = deps({ version: "0.21.0" });
  await expect(updateHostIfOlder(machine, "0.21.0", value)).resolves.toBe("current");
  expect(commands).toEqual([]);
});

it("waits while a turn runs on the host, since updating restarts it", async () => {
  const { value, commands } = deps({ version: "0.15.0", running: true });
  await expect(updateHostIfOlder(machine, "0.21.0", value)).resolves.toBe("busy");
  expect(commands).toEqual([]);
});

it("leaves a host that asks for a password to Settings", async () => {
  const { value, commands } = deps({ version: "0.15.0", jobs: [{ done: false, prompt: { id: "p" } }] });
  await expect(updateHostIfOlder(machine, "0.21.0", value)).resolves.toBe("skipped");
  expect(commands.at(-1)).toEqual(["remote_ssh_cancel", { jobId: "job-1" }]);
});

it("never touches a machine reached by URL", async () => {
  const { value, commands } = deps({ version: "0.15.0" });
  await expect(updateHostIfOlder({ ...machine, ssh: null }, "0.21.0", value)).resolves.toBe("skipped");
  expect(commands).toEqual([]);
});
