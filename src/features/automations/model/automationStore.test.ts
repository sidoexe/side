// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
const home = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("../../connections/model/homeCapability", () => ({
  homeWith: async (capability: string) => (capability === "automations" ? home.value : undefined),
}));

const machine = { id: "pro", name: "Pro", endpoint: "", environmentId: "env-pro" };

beforeEach(() => {
  vi.resetModules();
  invoke.mockReset();
  localStorage.clear();
  home.value = undefined;
});

it("uses this computer's store without a home machine", async () => {
  invoke.mockResolvedValue([]);
  const { automationCall } = await import("./automationStore");
  await automationCall("automations_claim_due", { automationId: "a" });
  expect(invoke.mock.calls).toEqual([["automations_claim_due", { automationId: "a" }]]);
});

it("copies local automations to the host once, then claims there", async () => {
  home.value = machine;
  const methods: string[] = [];
  invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "automations_list") return [{ id: "a1" }, { id: "a2" }];
    methods.push(`${args.method}:${args.params.automation?.id ?? args.params.automationId ?? ""}`);
    return null;
  });
  const { automationCall } = await import("./automationStore");
  await automationCall("automations_claim_due", { automationId: "a1" });
  await automationCall("automation_run_update", { runId: "r" });
  expect(methods).toEqual([
    "automations.import:a1",
    "automations.import:a2",
    "automations.claimDue:a1",
    "automations.updateRun:",
  ]);
});
