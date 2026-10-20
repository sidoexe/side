import { expect, it, vi } from "vitest";
import type { RemoteMachine } from "./protocol";

const describe = vi.fn();
vi.mock("./connections", () => ({
  remoteRequest: (...args: unknown[]) => describe(...args),
}));

const { machineCapabilities } = await import("./homeCapability");

it("asks a host again once its capabilities are a few minutes old", async () => {
  const machine = { id: "home" } as RemoteMachine;
  describe.mockResolvedValueOnce({ capabilities: ["projects.rail"] });
  describe.mockResolvedValueOnce({ capabilities: ["projects.rail", "web.apps"] });

  expect(await machineCapabilities(machine, 0)).toEqual(["projects.rail"]);
  expect(await machineCapabilities(machine, 60_000)).toEqual(["projects.rail"]);
  expect(await machineCapabilities(machine, 5 * 60_000)).toContain("web.apps");
  expect(describe).toHaveBeenCalledTimes(2);
});
