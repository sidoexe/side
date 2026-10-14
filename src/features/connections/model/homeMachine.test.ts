// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { homeMachineChoice, resolveHomeMachine, setHomeMachine } from "./homeMachine";

const machine = (id: string) => ({
  id,
  name: id,
  endpoint: `ssh://${id}`,
  environmentId: `env-${id}`,
  ssh: { target: id, remotePort: 3775 },
});

beforeEach(() => localStorage.clear());

it("uses the only connected machine until another choice is saved", () => {
  const pro = machine("pro");
  const air = machine("air");
  expect(homeMachineChoice()).toBeUndefined();
  expect(resolveHomeMachine([pro])).toBe(pro);
  expect(resolveHomeMachine([pro, air])).toBeUndefined();
  setHomeMachine("env-air");
  expect(resolveHomeMachine([pro, air])).toBe(air);
  setHomeMachine(undefined);
  expect(resolveHomeMachine([pro])).toBe(pro);
});

it("falls back to the automatic choice when the saved machine is gone, or the old Off was saved", () => {
  const pro = machine("pro");
  setHomeMachine("env-gone");
  expect(resolveHomeMachine([pro])).toBe(pro);
  localStorage.setItem("side.homeMachine.v1", JSON.stringify({ disabled: true }));
  expect(resolveHomeMachine([pro])).toBe(pro);
});
