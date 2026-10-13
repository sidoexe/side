// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
const home = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("./employeeStorage", () => ({ employeeHome: async () => home.value }));

const machine = { id: "pro", name: "Pro", endpoint: "", environmentId: "env-pro" };

beforeEach(() => {
  vi.resetModules();
  invoke.mockReset();
  localStorage.clear();
  home.value = undefined;
});

it("uses this computer's store without a home machine", async () => {
  invoke.mockResolvedValue({ id: "s1", blocks: [] });
  const chats = await import("./employeeTranscripts");
  await chats.getEmployeeTranscript("s1");
  await chats.deleteEmployeeTranscript("s1");
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["mono_session_get"]);
});

it("copies a local chat to the host once, oldest page first, then reads the host's", async () => {
  home.value = machine;
  const hostCalls: Array<{ method: string; params: any }> = [];
  let onHost: unknown = null;
  invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "mono_session_get")
      return {
        id: "s1", cwd: "/Users/me", harness: "claude", createdAt: 1, updatedAt: 2,
        blocks: [{ id: "u2" }, { id: "a2" }],
        monoTranscript: { before: 3, firstBlockId: "u2" },
      };
    if (command === "mono_session_page")
      return args.before === 3
        ? { blocks: [{ id: "u1" }, { id: "a1" }], before: 1, hasNewer: true }
        : { blocks: [{ id: "u0" }, { id: "a0" }], before: null, hasNewer: true };
    if (command !== "remote_request") throw new Error(command);
    hostCalls.push(args);
    if (args.method === "employees.sessionGet") return onHost;
    if (args.method === "employees.sessionUpsert") {
      onHost = { id: "s1", blocks: args.params.session.blocks };
      return {};
    }
    throw new Error(args.method);
  });
  const chats = await import("./employeeTranscripts");
  const record = await chats.getEmployeeTranscript<{ blocks: Array<{ id: string }> }>("s1");
  const upsert = hostCalls.find((call) => call.method === "employees.sessionUpsert")!.params;
  expect(upsert.session.blocks.map((block: { id: string }) => block.id)).toEqual(
    ["u0", "a0", "u1", "a1", "u2", "a2"],
  );
  expect(upsert.session).not.toHaveProperty("monoTranscript");
  expect(upsert.session).not.toHaveProperty("createdAt");
  expect(upsert).toMatchObject({ blocksChanged: true, appendOnly: false, baseLastBlockId: null });
  expect(record!.blocks).toHaveLength(6);
  await chats.getEmployeeTranscript("s1");
  expect(hostCalls.filter((call) => call.method === "employees.sessionUpsert")).toHaveLength(1);
});

it("does not bring a chat deleted on the host back from this computer", async () => {
  home.value = machine;
  const methods: string[] = [];
  invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "mono_session_get") return { id: "s1", blocks: [{ id: "u" }] };
    methods.push(args.method);
    return null;
  });
  const chats = await import("./employeeTranscripts");
  await chats.deleteEmployeeTranscript("s1");
  expect(await chats.getEmployeeTranscript("s1")).toBeNull();
  expect(methods).toEqual(["employees.sessionDelete", "employees.sessionGet"]);
});
