// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { saveProviderAccount } from "../../providers/model/providerAccounts";
import { setCachedRateLimits } from "../../providers/model/rateLimitsCache";
import { idleRateLimits } from "../../providers/model/rateLimits";
import { MonoAccountPicker } from "./MonoAccountPicker";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  saveProviderAccount({ id: "account-work", provider: "claude", label: "work" });
  const at = Date.now();
  setCachedRateLimits("claude", "default", {
    ...idleRateLimits("claude"),
    session: { usedPercent: 82, windowMinutes: 300, resetsAt: at + 3_600_000 },
    weekly: { usedPercent: 59, windowMinutes: 10_080, resetsAt: at + 2 * 86_400_000 },
    updatedAt: at,
    status: "ready",
  });
  setCachedRateLimits("claude", "account-work", {
    ...idleRateLimits("claude"),
    updatedAt: at,
    error: "Sign-in expired",
    status: "error",
  });
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

function render(props: Partial<Parameters<typeof MonoAccountPicker>[0]> = {}) {
  const calls = { change: vi.fn(), balanced: vi.fn() };
  act(() =>
    root.render(
      createElement(MonoAccountPicker, {
        provider: "claude",
        value: "default",
        balanced: false,
        onChange: calls.change,
        onBalanced: calls.balanced,
        ...props,
      }),
    ),
  );
  return calls;
}

const button = (label: RegExp) =>
  [...document.querySelectorAll("button")].find((entry) => label.test(entry.textContent ?? ""))!;

it("lists every account with its windows and errors, and Balanced above them", async () => {
  const calls = render();
  await act(async () => document.querySelector<HTMLButtonElement>("[aria-haspopup=menu]")!.click());
  const menu = document.querySelector("[role=menu]")!;
  expect(menu.textContent).toContain("Balanced");
  expect(menu.textContent).toContain("Weekly");
  expect(menu.textContent).toContain("Sign-in expired");

  await act(async () => button(/^work/).click());
  expect(calls.change).toHaveBeenCalledWith("account-work");
});

it("turns Balanced on, and names the account it is on while balanced", async () => {
  const calls = render();
  await act(async () => document.querySelector<HTMLButtonElement>("[aria-haspopup=menu]")!.click());
  await act(async () => button(/^Balanced/).click());
  expect(calls.balanced).toHaveBeenCalled();

  render({ balanced: true });
  expect(document.querySelector("[aria-haspopup=menu]")!.getAttribute("aria-label")).toBe(
    "Account: Balanced",
  );
});
