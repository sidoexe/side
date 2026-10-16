import { expect, it, vi } from "vitest";
import type { RemoteMachine } from "./protocol";

const describe = vi.fn();
vi.mock("./connections", () => ({
  loadRemoteMachines: vi.fn(async () => []),
  remoteRequest: (...args: unknown[]) => describe(...args),
}));

const { machineCapabilities } = await import("./homeCapability");

it("asks a host again once its capabilities are a few minutes old", async () => {
  const machine = { id: "home" } as RemoteMachine;
  describe.mockResolvedValueOnce({ capabilities: ["employees.inbox"] });
  describe.mockResolvedValueOnce({ capabilities: ["employees.inbox", "employees.accounts"] });

  expect(await machineCapabilities(machine, 0)).toEqual(["employees.inbox"]);
  expect(await machineCapabilities(machine, 60_000)).toEqual(["employees.inbox"]);
  expect(await machineCapabilities(machine, 5 * 60_000)).toContain("employees.accounts");
  expect(describe).toHaveBeenCalledTimes(2);
});
