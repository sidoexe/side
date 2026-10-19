// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  recordColleagueWork,
  type LiveLaunch,
} from "../model/colleagueWork";
import { addSessionsToReview } from "../../sessions/model/sessionReview";
import { ColleagueWorkStrip } from "./ColleagueWork";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
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

/** One window's look at one session; it saw that session go when `live` is unset. */
function track(id: string, live: LiveLaunch | undefined, now: number) {
  recordColleagueWork(
    "m",
    [
      {
        launch: {
          sessionId: id,
          cwd: "/code/app",
          title: `claude · ${id}`,
          harness: "claude",
          model: "claude:x",
        },
        thread: "t",
      },
    ],
    new Map(live ? [[id, live]] : []),
    now,
    (gone) => gone === id,
  );
}

function render(onOpen = vi.fn(), onShowAll = vi.fn()) {
  act(() =>
    root.render(
      createElement(ColleagueWorkStrip, {
        monoId: "m",
        agent: { name: "CTO", mascot: "crab", color: "red", projects: [] },
        onOpen,
        onShowAll,
      }),
    ),
  );
  return { onOpen, onShowAll };
}

it("shows nothing while the colleague has nothing running or new", () => {
  render();
  expect(container.querySelector("[data-colleague-work]")).toBeNull();
});

it("keeps what waits, what runs and what waits to be checked in sight", () => {
  const now = Date.now();
  track("checked", { state: "working", title: "Old docs" }, now - 6_000);
  track("checked", undefined, now - 5_500);
  track("ended", { state: "working", title: "Ship docs" }, now - 5_000);
  track("ended", undefined, now - 1_000);
  addSessionsToReview([{ id: "ended", cwd: "/code/app" }]);
  track("ask", { state: "input", title: "Fix CI", activity: "Approve git push" }, now);
  track("run", { state: "working", title: "Write tests", activity: "Running npm test" }, now);

  const { onOpen, onShowAll } = render();
  const strip = container.querySelector("[data-colleague-work]")!;
  expect(strip.textContent).toContain(
    "1 needs input · 1 working · To review: 1 done",
  );
  const rows = [...strip.querySelectorAll("[data-colleague-work-item]")];
  expect(rows.map((row) => row.getAttribute("data-colleague-work-item"))).toEqual([
    "ask",
    "run",
    "ended",
  ]);
  // The request is named here, and answered in its own session.
  expect(rows[0].textContent).toContain("Approve git push");
  act(() => (rows[0] as HTMLButtonElement).click());
  expect(onOpen).toHaveBeenCalledWith("ask");

  const all = [...strip.querySelectorAll("button")].find(
    (button) => button.textContent === "All sessions",
  )!;
  act(() => all.click());
  expect(onShowAll).toHaveBeenCalled();
});
