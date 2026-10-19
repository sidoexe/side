// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  checkedSessions,
  forgetCheckedSessions,
  noteSessionsChecked,
} from "./sessionChecked";

function entry(id: string) {
  return { id, cwd: "/repo", title: `Fix ${id}`, harness: "claude" as const };
}

describe("checked sessions", () => {
  beforeEach(() => localStorage.clear());

  it("lists the last checked first and survives a reload", () => {
    noteSessionsChecked([entry("a")]);
    noteSessionsChecked([entry("b")]);
    noteSessionsChecked([entry("a")]);
    expect(checkedSessions().map((e) => e.id)).toEqual(["a", "b"]);
    expect(
      JSON.parse(localStorage.getItem("monocode.sessionsChecked")!),
    ).toEqual([entry("a"), entry("b")]);
  });

  it("keeps only the latest 50", () => {
    for (let i = 0; i < 60; i++) noteSessionsChecked([entry(`s${i}`)]);
    const ids = checkedSessions().map((e) => e.id);
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe("s59");
  });

  it("forgets archived or deleted sessions", () => {
    noteSessionsChecked([entry("a"), entry("b")]);
    forgetCheckedSessions(["a"]);
    expect(checkedSessions().map((e) => e.id)).toEqual(["b"]);
  });

  it("ignores a malformed store", () => {
    localStorage.setItem("monocode.sessionsChecked", '[{"id":1},"x"]');
    expect(checkedSessions()).toEqual([]);
  });
});
