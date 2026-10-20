// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionBoard } from "../hooks/useSessionBoard";
import type { LiveAgent } from "../model/liveAgents";
import { BoardView } from "./BoardView";

// The window's own buttons need Tauri, which a test has none of.
vi.mock("../../../app/shell/WindowControls", () => ({ WindowControls: () => null }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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

const agent = (id: string, extra: Partial<LiveAgent> = {}): LiveAgent => ({
  id,
  cwd: "/code/app",
  title: `Task ${id}`,
  harness: "claude",
  activity: "Working",
  needsApproval: false,
  done: false,
  ...extra,
});

function render(board: Partial<SessionBoard> = {}) {
  const full: SessionBoard = {
    enabled: true,
    review: [],
    working: [],
    checked: [],
    onSelect: vi.fn(),
    onMarkChecked: vi.fn(),
    ...board,
  };
  act(() =>
    root.render(
      createElement(BoardView, { board: full, besideRail: true, onClose: vi.fn() }),
    ),
  );
  return full;
}

const column = (label: string) =>
  container.querySelector(`[data-board-column="${label}"]`)!;

it("lays every session out in Working and To review", () => {
  const board = render({
    review: [
      agent("ask", { needsApproval: true }),
      agent("done", { done: true }),
    ],
    working: [agent("run")],
    checked: [{ id: "old", cwd: "/code/app", title: "Old task", harness: "claude" }],
  });
  const ids = (label: string, attr: string) =>
    [...column(label).querySelectorAll(`[${attr}]`)].map((node) =>
      node.getAttribute(attr),
    );
  expect(ids("To review", "data-live-agent-card")).toEqual(["ask", "done"]);
  expect(ids("Working", "data-live-agent-card")).toEqual(["run"]);

  act(() =>
    (column("Working").querySelector("[data-live-agent-card]") as HTMLElement).click(),
  );
  expect(board.onSelect).toHaveBeenCalledWith("run");
  act(() =>
    (container.querySelector('[data-live-agent-check="done"]') as HTMLElement).click(),
  );
  expect(board.onMarkChecked).toHaveBeenCalledWith(
    expect.objectContaining({ id: "done" }),
  );
});

it("says how to turn the board on when Working agents is off", () => {
  render({ enabled: false });
  expect(container.querySelector("[data-board-column]")).toBeNull();
  expect(container.textContent).toContain("Turn on Working agents");
});
