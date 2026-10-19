// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { createMono, findMono, monoDelegation, monoLook, saveMonoDelegation } from "./mono";
import { delegationRules } from "./monoFiles";

beforeEach(() => localStorage.clear());

it("never starts sessions until the user allows it, and stores only the exceptions", () => {
  const mono = createMono();
  expect(monoDelegation(findMono(mono.id)!)).toBe("never");
  saveMonoDelegation(mono.id, "ask");
  expect(findMono(mono.id)?.delegation).toBe("ask");
  expect(monoLook(findMono(mono.id)!).delegation).toBe("ask");
  saveMonoDelegation(mono.id, "never");
  expect(findMono(mono.id)?.delegation).toBeUndefined();
});

it("tells the Colleague when it may start sessions", () => {
  const never = delegationRules("never").join("\n");
  expect(never).toContain("Never use app sessions.start");
  expect(never).not.toContain("<session_completion_rules>");

  const ask = delegationRules("ask").join("\n");
  expect(ask).toContain("only when the user explicitly asks");
  expect(ask).not.toContain("on your own");
  expect(ask).toContain("<session_completion_rules>");

  const free = delegationRules("free").join("\n");
  expect(free).toContain("use app sessions.start on your own");
});
