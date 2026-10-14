import { expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

it("keeps automations in this computer's store", async () => {
  invoke.mockResolvedValue([]);
  const { automationCall } = await import("./automationStore");
  await automationCall("automations_claim_due", { automationId: "a" });
  expect(invoke.mock.calls).toEqual([["automations_claim_due", { automationId: "a" }]]);
});
