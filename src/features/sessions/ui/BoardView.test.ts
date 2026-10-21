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

function render(
  board: Partial<SessionBoard> = {},
  props: {
    peek?: boolean;
    onClose?: () => void;
    onExpand?: () => void;
    onArchiveSessions?: (ids: readonly string[]) => void;
    onDeleteSession?: (id: string) => void;
    onDeleteSessions?: (ids: readonly string[]) => void;
  } = {},
) {
  const full: SessionBoard = {
    enabled: true,
    review: [],
    working: [],
    checked: [],
    onSelect: vi.fn(),
    onMarkChecked: vi.fn(),
    onReorder: vi.fn(),
    ...board,
  };
  act(() =>
    root.render(
      createElement(BoardView, {
        board: full,
        besideRail: true,
        onClose: vi.fn(),
        ...props,
      }),
    ),
  );
  return full;
}

const column = (label: string) =>
  container.querySelector(`[data-board-column="${label}"]`)!;

it("lays every session out in Working, To review and Checked", () => {
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
  expect(ids("Checked", "data-checked-session")).toEqual(["old"]);

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

it("narrows to one column beside an open session, and widens back", () => {
  const onClose = vi.fn();
  const onExpand = vi.fn();
  render(
    { working: [agent("run")], review: [agent("done", { done: true })] },
    { peek: true, onClose, onExpand },
  );
  expect(container.querySelector("[data-board-peek]")).not.toBeNull();
  expect(column("Working")).not.toBeNull();
  expect(column("To review")).not.toBeNull();

  act(() =>
    (container.querySelector('[aria-label="Expand board"]') as HTMLElement).click(),
  );
  expect(onExpand).toHaveBeenCalledOnce();
  act(() =>
    (container.querySelector('[aria-label="Close board"]') as HTMLElement).click(),
  );
  expect(onClose).toHaveBeenCalledOnce();
});

it("archives or deletes checked sessions, one at a time or all at once", () => {
  const onArchiveSessions = vi.fn();
  const onDeleteSession = vi.fn();
  const onDeleteSessions = vi.fn();
  render(
    {
      checked: [
        { id: "a", cwd: "/code/app", title: "Task a", harness: "claude" },
        { id: "b", cwd: "/code/app", title: "Task b", harness: "claude" },
      ],
    },
    { onArchiveSessions, onDeleteSession, onDeleteSessions },
  );
  const click = (label: string) =>
    act(() =>
      (container.querySelector(`[aria-label="${label}"]`) as HTMLElement).click(),
    );

  click("Archive Task a");
  expect(onArchiveSessions).toHaveBeenLastCalledWith(["a"]);
  click("Delete Task b");
  expect(onDeleteSession).toHaveBeenLastCalledWith("b");
  click("Archive all checked");
  expect(onArchiveSessions).toHaveBeenLastCalledWith(["a", "b"]);
  click("Delete all checked");
  expect(onDeleteSessions).toHaveBeenLastCalledWith(["a", "b"]);
});

it("offers no column actions while nothing is checked", () => {
  render({}, { onArchiveSessions: vi.fn(), onDeleteSessions: vi.fn() });
  expect(container.querySelector('[aria-label="Archive all checked"]')).toBeNull();
  expect(container.querySelector('[aria-label="Delete all checked"]')).toBeNull();
});
