import { describe, expect, it } from "vitest";
import { steppedWebAppZoom } from "./webAppZoom";

describe("web app zoom", () => {
  it("walks the browser's steps and stops at the ends", () => {
    expect(steppedWebAppZoom(1, "in")).toBe(1.1);
    expect(steppedWebAppZoom(1, "out")).toBe(0.9);
    expect(steppedWebAppZoom(3, "in")).toBe(3);
    expect(steppedWebAppZoom(0.5, "out")).toBe(0.5);
    expect(steppedWebAppZoom(1.75, "reset")).toBe(1);
  });

  it("joins the steps from a zoom between two of them", () => {
    expect(steppedWebAppZoom(1.3, "in")).toBe(1.5);
    expect(steppedWebAppZoom(1.3, "out")).toBe(1.25);
  });
});
