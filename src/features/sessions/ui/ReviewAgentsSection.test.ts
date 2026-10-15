// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveAgent } from "../model/liveAgents";
import { ReviewAgentsSection } from "./ReviewAgentsSection";

let container: HTMLDivElement;
let root: Root;

function agent(
  id: string,
  cwd: string,
  patch: Partial<LiveAgent> = {},
): LiveAgent {
  return {
    id,
    cwd,
    title: `Agent ${id}`,
    harness: "codex",
    activity: "Working",
    startedAt: 1_000,
    needsApproval: false,
    done: false,
    ...patch,
  };
}

function render(
  props: Partial<ComponentProps<typeof ReviewAgentsSection>> &
    Pick<ComponentProps<typeof ReviewAgentsSection>, "agents">,
) {
  act(() =>
    root.render(
      createElement(ReviewAgentsSection, {
        groupLabels: {},
        groupColors: {},
        groupCustomColors: {},
        groupMascots: {},
        ...props,
      }),
    ),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("ReviewAgentsSection", () => {
  it("renders nothing while no agent waits on the user", () => {
    render({ agents: [] });
    expect(container.innerHTML).toBe("");
  });

  it("lists a single done or blocked agent from any project", () => {
    const onSelect = vi.fn();
    render({
      agents: [
        agent("a", "/repo/a", { needsApproval: true }),
        agent("b", "/repo/b", { done: true, activity: "Done" }),
      ],
      groupLabels: { "/repo/a": "Alpha", "/repo/b": "Beta" },
      onSelect,
    });

    const cards = Array.from(
      container.querySelectorAll<HTMLElement>("[data-live-agent-card]"),
    );
    expect(cards.map((card) => card.dataset.liveAgentCard)).toEqual(["a", "b"]);
    expect(cards[0].textContent).toContain("Need approval");
    expect(cards[0].textContent).toContain("Alpha");
    expect(cards[1].textContent).toContain("Done");
    expect(cards[1].textContent).toContain("Beta");
    expect(container.textContent).toContain("To review");

    act(() => cards[1].click());
    expect(onSelect).toHaveBeenCalledWith("b");
  });
});
