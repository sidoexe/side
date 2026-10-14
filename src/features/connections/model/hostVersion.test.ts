import { expect, it } from "vitest";
import { hostIsOlder } from "./hostVersion";

it("calls a host older than this desktop's release older", () => {
  expect(hostIsOlder("0.15.0", "0.20.0")).toBe(true);
  expect(hostIsOlder("0.20.0", "0.20.0")).toBe(false);
  expect(hostIsOlder("0.21.0", "0.20.0")).toBe(false);
  expect(hostIsOlder("0.9.3", "0.10.0")).toBe(true);
  // Hosts before 0.20 do not say their version.
  expect(hostIsOlder(undefined, "0.20.0")).toBe(true);
  // A development desktop has nothing to compare.
  expect(hostIsOlder(undefined, "0.0.0-dev")).toBe(true);
  expect(hostIsOlder("0.15.0", "dev")).toBe(false);
});
