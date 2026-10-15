import { expect, it } from "vitest";
import { backgroundStep } from "./employeeBackgrounds";

it("sends a change made here unless the host has a newer one", () => {
  expect(backgroundStep({ updatedAt: 5, dirty: true }, { updatedAt: 3 }, true)).toBe("push");
  expect(backgroundStep({ updatedAt: 5, dirty: true }, undefined, false)).toBe("push");
  expect(backgroundStep({ updatedAt: 5, dirty: true }, { updatedAt: 6 }, true)).toBe("pull");
});

it("takes another desktop's newer change", () => {
  expect(backgroundStep({ updatedAt: 5 }, { updatedAt: 6, mimeType: "image/png" }, true)).toBe("pull");
  expect(backgroundStep(undefined, { updatedAt: 1 }, true)).toBe("pull");
  expect(backgroundStep({ updatedAt: 6 }, { updatedAt: 6 }, true)).toBe("none");
});

it("shares an image from before the host kept them, once", () => {
  expect(backgroundStep(undefined, undefined, true)).toBe("push");
  expect(backgroundStep({ updatedAt: 1 }, undefined, true)).toBe("none");
  expect(backgroundStep(undefined, undefined, false)).toBe("none");
});
