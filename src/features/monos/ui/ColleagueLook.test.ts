// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createMono,
  findMono,
  listMonos,
  monoLook,
  saveMonoAvatar,
  saveMonoMascot,
} from "../model/mono";
import { floatingMonoMenuMascots } from "../model/floatingMono";
import { ColleagueAvatar } from "./ColleagueAvatar";
import { ColleagueLookPicker } from "./ColleagueLookPicker";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("keeps an emoji or icon face, and a picked mascot takes its place again", () => {
  const { id } = createMono();
  saveMonoAvatar(id, { kind: "emoji", value: "🦊" });
  expect(findMono(id)?.avatar).toEqual({ kind: "emoji", value: "🦊" });
  expect(monoLook(findMono(id)!).avatar).toEqual({ kind: "emoji", value: "🦊" });

  saveMonoAvatar(id, { kind: "icon", value: "Rocket01" });
  expect(findMono(id)?.avatar).toEqual({ kind: "icon", value: "Rocket01" });

  saveMonoMascot(id, "ghost");
  expect(findMono(id)?.avatar).toBeUndefined();
  expect(findMono(id)?.mascot).toBe("ghost");
});

it("drops a malformed face from the stored roster", () => {
  const { id } = createMono();
  const roster = listMonos().map((mono) =>
    mono.id === id ? { ...mono, avatar: { kind: "icon", value: "../x" } } : mono,
  );
  localStorage.setItem("monocode:mono-roster", JSON.stringify(roster));
  expect(findMono(id)).toBeDefined();
  expect(findMono(id)?.avatar).toBeUndefined();
});

it("draws an emoji, an icon or the mascot", () => {
  const draw = (avatar?: Parameters<typeof ColleagueAvatar>[0]["avatar"]) =>
    act(() =>
      root.render(createElement(ColleagueAvatar, { mascot: "ghost", color: "#4f8cff", avatar })),
    );
  draw({ kind: "emoji", value: "🦊" });
  expect(container.querySelector("text")?.textContent).toBe("🦊");
  draw({ kind: "icon", value: "Rocket01" });
  expect(container.querySelector("svg svg")).not.toBeNull();
  expect(container.querySelector("text")).toBeNull();
  draw(undefined);
  expect(container.querySelector(".pixel-mascot")).not.toBeNull();
  // An icon this build does not know falls back to the mascot.
  draw({ kind: "icon", value: "Unknown" });
  expect(container.querySelector(".pixel-mascot")).not.toBeNull();
});

it("picks an emoji and an icon from the look picker", () => {
  const { id } = createMono();
  const render = () =>
    act(() =>
      root.render(createElement(ColleagueLookPicker, { monoId: id, look: monoLook(findMono(id)!) })),
    );
  render();
  const tab = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (button) => button.textContent === label,
    )!;
  act(() => tab("Emoji").click());
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="🐙"]')!.click());
  expect(findMono(id)?.avatar).toEqual({ kind: "emoji", value: "🐙" });

  render();
  act(() => tab("Icon").click());
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Brain"]')!.click());
  expect(findMono(id)?.avatar).toEqual({ kind: "icon", value: "Brain" });
});

it("shows a face in the menu bar as its color tile", () => {
  const [tile, mascot] = floatingMonoMenuMascots([
    { id: "a", name: "A", mascot: "ghost", color: "#123456", avatar: { kind: "emoji", value: "🦊" }, sessionId: null, status: "idle" },
    { id: "b", name: "B", mascot: "ghost", color: "#123456", sessionId: null, status: "idle" },
  ]);
  expect(tile.rects.every((rect) => rect.fill === "#123456")).toBe(true);
  expect(mascot.rects.length).toBeGreaterThan(tile.rects.length);
});
