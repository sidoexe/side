// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MonoThreadMenu } from "./MonoThreadMenu";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

let root: Root;
beforeEach(() => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

function render() {
  const calls = { select: vi.fn(), create: vi.fn(), rename: vi.fn(), remove: vi.fn() };
  act(() =>
    root.render(
      createElement(MonoThreadMenu, {
        threads: [
          { id: "seo", title: "Refonte SEO", createdAt: Date.now(), busy: false },
          { id: "bug", title: "Bug paiement", createdAt: Date.now() - 86_400_000, busy: true },
        ],
        current: "seo",
        onSelect: calls.select,
        onNew: calls.create,
        onRename: calls.rename,
        onDelete: calls.remove,
      }),
    ),
  );
  return calls;
}

const open = () =>
  act(async () => document.querySelector<HTMLButtonElement>("[data-mono-thread]")!.click());
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (entry) => entry.getAttribute("aria-label") === label || entry.textContent?.startsWith(label),
  )!;

it("names the open thread and switches to another or a new one", async () => {
  const calls = render();
  expect(document.querySelector("[data-mono-thread]")!.textContent).toContain("Refonte SEO");
  await open();
  expect(document.querySelector("[aria-label=Working]")).not.toBeNull();
  await act(async () => button("Bug paiement").click());
  expect(calls.select).toHaveBeenCalledWith("bug");
  await open();
  await act(async () => button("New thread").click());
  expect(calls.create).toHaveBeenCalled();
});

it("renames in place and asks once more before deleting", async () => {
  const calls = render();
  await open();
  await act(async () => button("Rename Bug paiement").click());
  const input = document.querySelector<HTMLInputElement>("[aria-label='Thread name']")!;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, "Stripe webhook");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => input.form!.requestSubmit());
  expect(calls.rename).toHaveBeenCalledWith("bug", "Stripe webhook");

  await act(async () => button("Delete Refonte SEO").click());
  expect(calls.remove).not.toHaveBeenCalled();
  await act(async () => button("Delete").click());
  expect(calls.remove).toHaveBeenCalledWith("seo");
});
