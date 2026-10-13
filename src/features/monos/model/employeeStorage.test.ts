// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const home = {
  id: "pro",
  name: "Pro",
  endpoint: "http://127.0.0.1:3775",
  environmentId: "env-pro",
  ssh: null,
};

type Host = {
  capabilities: string[];
  files: Record<string, string>;
  calls: string[];
};

function answer(host: Host | undefined, local: Record<string, string>) {
  invoke.mockImplementation(async (command: string, args: Record<string, any>) => {
    if (command === "remote_machines") return host ? [home] : [];
    if (command === "mono_load")
      return { id: args.mono, soul: local["SOUL.md"] ?? null, memory: local["MEMORY.md"] ?? "",
        soulHash: "local", memoryHash: "local", topics: ["notes"], dir: "/local", memoryPath: "/local/MEMORY.md" };
    if (command === "mono_read") return { text: local[args.path] ?? null, hash: "local" };
    if (command === "mono_save") return "local-hash";
    if (command !== "remote_request" || !host) throw new Error(`Unexpected ${command}`);
    const { method, params } = args;
    host.calls.push(method);
    if (method === "environment.describe") return { capabilities: host.capabilities };
    if (method === "employees.import") {
      for (const [path, text] of Object.entries(params.files as Record<string, string>))
        host.files[path] ??= text;
      return { written: 1 };
    }
    if (method === "employees.load")
      return { id: params.mono, soul: host.files["SOUL.md"] ?? null, memory: host.files["MEMORY.md"] ?? "" };
    if (method === "employees.save") {
      if (params.expectedHash === "stale") throw "Host rejected request: conflict";
      host.files[params.path] = params.text;
      return "host-hash";
    }
    throw new Error(`Unexpected ${method}`);
  });
}

beforeEach(() => {
  vi.resetModules();
  invoke.mockReset();
  localStorage.clear();
});

it("keeps employees on this computer without a home machine", async () => {
  answer(undefined, { "MEMORY.md": "- local" });
  const storage = await import("./employeeStorage");
  expect((await storage.loadEmployeeFiles("e1", null)).memory).toBe("- local");
  expect(await storage.saveEmployeeFile("e1", null, "MEMORY.md", "x", null)).toBe("local-hash");
});

it("moves an employee's files to the home machine once, then uses the host's copy", async () => {
  const host: Host = { capabilities: ["employees"], files: {}, calls: [] };
  answer(host, {
    "SOUL.md": "# Soul",
    "MEMORY.md": "- local",
    "habits.json": "[]",
    "memory/notes.md": "notes",
  });
  const storage = await import("./employeeStorage");
  expect(await storage.loadEmployeeFiles("e1", null)).toMatchObject({ soul: "# Soul", memory: "- local" });
  expect(host.files).toEqual({
    "SOUL.md": "# Soul",
    "MEMORY.md": "- local",
    "habits.json": "[]",
    "memory/notes.md": "notes",
  });
  await storage.readEmployeeFile("e1", null, "habits.json").catch(() => undefined);
  expect(host.calls.filter((method) => method === "employees.import")).toHaveLength(1);
  expect(await storage.saveEmployeeFile("e1", null, "MEMORY.md", "- shared", "h")).toBe("host-hash");
  expect(host.files["MEMORY.md"]).toBe("- shared");
});

it("reports the host's refusal of a stale save as a conflict", async () => {
  answer({ capabilities: ["employees"], files: {}, calls: [] }, {});
  const storage = await import("./employeeStorage");
  await expect(storage.saveEmployeeFile("e1", null, "habits.json", "[1]", "stale")).rejects.toBe(
    "conflict",
  );
});

it("stays local when the home machine's host does not keep employees yet", async () => {
  const host: Host = { capabilities: ["sessions"], files: {}, calls: [] };
  answer(host, { "MEMORY.md": "- local" });
  const storage = await import("./employeeStorage");
  expect((await storage.loadEmployeeFiles("e1", null)).memory).toBe("- local");
  expect(host.calls).toEqual(["environment.describe"]);
});
