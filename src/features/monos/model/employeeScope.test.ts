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

const block = (id: string) => ({ id, role: "user", text: id });
const header = { id: "s1", cwd: "/tmp", modelSettings: {} };

type Side = { files: Record<string, string>; chat: { id: string }[] | null };

function answer(local: Side, host: Side, calls: { method: string; params: any }[]) {
  const load = (side: Side, mono: string) => ({
    id: mono,
    soul: side.files["SOUL.md"] ?? null,
    memory: side.files["MEMORY.md"] ?? "",
    topics: [],
  });
  const read = (side: Side, path: string) => ({ text: side.files[path] ?? null, hash: "h" });
  // The newest block in one page, the rest one page before.
  const record = (side: Side) =>
    side.chat && {
      ...header,
      blocks: side.chat.slice(-1),
      monoTranscript: { before: side.chat.length > 1 ? 1 : null },
      createdAt: 1,
      updatedAt: 2,
    };
  const page = (side: Side) => ({ blocks: side.chat!.slice(0, -1), before: null, hasNewer: true });
  invoke.mockImplementation(async (command: string, args: Record<string, any>) => {
    if (command === "remote_machines") return [home];
    if (command === "mono_load") return load(local, args.mono);
    if (command === "mono_read") return read(local, args.path);
    if (command === "mono_save") {
      local.files[args.path] = args.text;
      return "h";
    }
    if (command === "mono_session_get") return record(local);
    if (command === "mono_session_page") return page(local);
    if (command === "mono_session_upsert") {
      local.chat = args.session.blocks;
      return {};
    }
    if (command !== "remote_request") throw new Error(`Unexpected ${command}`);
    const { method, params } = args;
    calls.push({ method, params });
    if (method === "environment.describe") return { capabilities: ["employees"] };
    if (method === "employees.import") return { written: 0 };
    if (method === "employees.load") return load(host, params.mono);
    if (method === "employees.read") return read(host, params.path);
    if (method === "employees.save") {
      host.files[params.path] = params.text;
      return "h";
    }
    if (method === "employees.sessionGet") return record(host);
    if (method === "employees.sessionPage") return page(host);
    if (method === "employees.sessionUpsert") {
      host.chat = params.appendOnly ? [...host.chat!, ...params.session.blocks] : params.session.blocks;
      return {};
    }
    throw new Error(`Unexpected ${method}`);
  });
}

const roster = (localOnly: boolean) =>
  localStorage.setItem(
    "monocode:mono-roster",
    JSON.stringify([
      { id: "e1", sessionId: "s1", mascot: "crab", color: "red", projects: [], ...(localOnly ? { localOnly } : {}) },
    ]),
  );

beforeEach(() => {
  vi.resetModules();
  invoke.mockReset();
  localStorage.clear();
});

it("brings the host's files and whole chat here when kept on this computer only", async () => {
  const local: Side = { files: { "MEMORY.md": "- stale" }, chat: [block("old")] };
  const host: Side = {
    files: { "SOUL.md": "# Soul", "MEMORY.md": "- shared", "habits.json": "[]" },
    chat: [block("a"), block("b")],
  };
  answer(local, host, []);
  roster(false);
  const { setEmployeeLocalOnly } = await import("./employeeScope");
  const { findMono } = await import("./mono");
  await setEmployeeLocalOnly("e1", true);
  expect(local.files).toEqual(host.files);
  expect(local.chat).toEqual([block("a"), block("b")]);
  expect(findMono("e1")?.localOnly).toBe(true);
});

it("replaces the host's copy with this computer's when shared again", async () => {
  const local: Side = { files: { "MEMORY.md": "- here" }, chat: [block("x"), block("y")] };
  const host: Side = { files: { "MEMORY.md": "- stale" }, chat: [block("old")] };
  const calls: { method: string; params: any }[] = [];
  answer(local, host, calls);
  roster(true);
  const { setEmployeeLocalOnly } = await import("./employeeScope");
  const { findMono } = await import("./mono");
  await setEmployeeLocalOnly("e1", false);
  expect(host.files["MEMORY.md"]).toBe("- here");
  expect(host.chat).toEqual([block("x"), block("y")]);
  // The host's last block is the base, so it replaces rather than merges.
  expect(calls.find((call) => call.method === "employees.sessionUpsert")?.params.baseLastBlockId).toBe(
    "old",
  );
  expect(findMono("e1")?.localOnly).toBeUndefined();
});

it("leaves the employee as it was when the host cannot be reached", async () => {
  invoke.mockImplementation(async (command: string) => {
    if (command === "remote_machines") return [home];
    throw new Error("offline");
  });
  roster(false);
  const { setEmployeeLocalOnly } = await import("./employeeScope");
  const { findMono } = await import("./mono");
  await expect(setEmployeeLocalOnly("e1", true)).rejects.toThrow();
  expect(findMono("e1")?.localOnly).toBeUndefined();
});
