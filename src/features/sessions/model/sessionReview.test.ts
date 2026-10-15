// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  markSessionsReviewed,
  replaceSessionsToReview,
  sessionsToReview,
} from "./sessionReview";

describe("sessions to review", () => {
  beforeEach(() => localStorage.clear());

  it("keeps each session's folder and survives a reload", () => {
    replaceSessionsToReview(new Set(["a", "b"]), (id) => `/p/${id}`);
    replaceSessionsToReview(new Set(["a", "b", "c"]), () => "/other");
    expect([...sessionsToReview()]).toEqual([
      ["a", "/p/a"],
      ["b", "/p/b"],
      ["c", "/other"],
    ]);
    expect(
      JSON.parse(localStorage.getItem("monocode.sessionsToReview")!),
    ).toEqual({
      a: "/p/a",
      b: "/p/b",
      c: "/other",
    });
  });

  it("drops sessions the user checked", () => {
    replaceSessionsToReview(new Set(["a", "b"]), () => "/p");
    markSessionsReviewed(["a"]);
    expect([...sessionsToReview().keys()]).toEqual(["b"]);
  });

  it("keeps the same snapshot while nothing changes", () => {
    replaceSessionsToReview(new Set(["a"]), () => "/p");
    const first = sessionsToReview();
    replaceSessionsToReview(new Set(["a"]), () => "/q");
    expect(sessionsToReview()).toBe(first);
  });
});
