// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import {
  createMono,
  findMono,
  forgetMonoThread,
  monoForSession,
  monoThreads,
  renameMonoThread,
  saveMonoSessionId,
  startMonoThread,
  switchMonoThread,
} from "./mono";

beforeEach(() => localStorage.clear());

it("keeps every thread a Colleague opens, and knows each as its conversation", () => {
  const mono = createMono();
  saveMonoSessionId(mono.id, "first");
  startMonoThread(mono.id);
  expect(findMono(mono.id)?.sessionId).toBeUndefined();
  saveMonoSessionId(mono.id, "second");

  expect(findMono(mono.id)?.sessionId).toBe("second");
  expect(monoThreads(findMono(mono.id)!).map((thread) => thread.id).sort()).toEqual([
    "first",
    "second",
  ]);
  expect(monoForSession("first")?.id).toBe(mono.id);
  expect(monoForSession("second")?.id).toBe(mono.id);
  expect(monoForSession("other")).toBeUndefined();
});

it("switches only to its own threads, renames them, and reopens another when one goes", () => {
  const mono = createMono();
  saveMonoSessionId(mono.id, "first");
  startMonoThread(mono.id);
  saveMonoSessionId(mono.id, "second");

  expect(switchMonoThread(mono.id, "nope")).toBe(false);
  expect(switchMonoThread(mono.id, "first")).toBe(true);
  expect(findMono(mono.id)?.sessionId).toBe("first");

  renameMonoThread(mono.id, "first", "  Bug paiement  ");
  expect(monoThreads(findMono(mono.id)!).find((t) => t.id === "first")?.title).toBe("Bug paiement");

  forgetMonoThread(mono.id, "first");
  expect(findMono(mono.id)?.sessionId).toBe("second");
  expect(monoForSession("first")).toBeUndefined();
  forgetMonoThread(mono.id, "second");
  expect(findMono(mono.id)?.sessionId).toBeUndefined();
  expect(findMono(mono.id)?.threads).toBeUndefined();
});

it("treats a Colleague from before threads as having its one conversation", () => {
  expect(monoThreads({ sessionId: "only" })).toEqual([{ id: "only", createdAt: 0 }]);
  expect(monoThreads({})).toEqual([]);
});
