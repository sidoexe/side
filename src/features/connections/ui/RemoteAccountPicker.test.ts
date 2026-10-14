// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { RemoteAccountPicker } from "./RemoteAccountPicker";
import { setRemoteAccountSlot } from "./remoteAccountSlot";
import type { HostAccountSummary } from "../model/protocol";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const accounts: HostAccountSummary[] = [
  { id: "auto", provider: "claude", label: "Balanced" },
  { id: "perso-1", provider: "claude", label: "6ido.exe" },
  { id: "perso-2", provider: "claude", label: "benchoubane.sid" },
];

let root: Root;
let footer: HTMLDivElement;
let requests: { method: string; params: Record<string, unknown> }[];
let codeResult: () => unknown;

beforeEach(() => {
  requests = [];
  codeResult = () => ({ accountId: "perso-3", label: "new.person" });
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (_command, input) => {
    const { method, params } = input as { method: string; params: Record<string, unknown> };
    requests.push({ method, params });
    if (method === "accounts.login")
      return { loginId: "login-1", url: "https://claude.com/cai/oauth/authorize?code=true", accountId: "perso-3" };
    if (method === "accounts.loginCode") return codeResult();
    if (method === "accounts.refresh")
      return [
        { id: "auto", provider: "claude", label: "Balanced" },
        {
          id: "perso-1",
          provider: "claude",
          label: "6ido.exe",
          usage: { fiveHour: { used: 9, resetsAt: Date.now() + 3_600_000 }, sevenDay: { used: 24 }, updatedAt: Date.now() },
        },
        {
          id: "perso-2",
          provider: "claude",
          label: "benchoubane.sid",
          usage: { fiveHour: { used: 100, resetsAt: Date.now() - 1_000 }, error: "Sign-in expired; reconnect this account" },
        },
      ];
    if (method === "accounts.list") return [];
    if (method === "accounts.found") return [{ configDir: "~/.claude-work", label: "work.person" }];
    if (method === "accounts.import") return { accountId: "perso-3", label: "work.person" };
    return {};
  });
  footer = document.createElement("div");
  document.body.append(footer);
  setRemoteAccountSlot({ sessionId: "shell", element: footer });
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  setRemoteAccountSlot(undefined);
  document.body.innerHTML = "";
});

async function render(props: Partial<Parameters<typeof RemoteAccountPicker>[0]> = {}) {
  await act(async () =>
    root.render(
      createElement(RemoteAccountPicker, {
        sessionId: "shell",
        machineId: "machine",
        harness: "claude",
        canSignIn: true,
        accounts,
        value: "auto",
        onChange: () => undefined,
        ...props,
      }),
    ),
  );
}

const item = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.textContent?.includes(text),
  )!;

async function openMenu() {
  await act(async () => footer.querySelector<HTMLButtonElement>("button")!.click());
}

async function typeCode(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Sign-in code"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => item("Connect").click());
}

it("adds a host account: opens Claude's page here and hands the code to the host", async () => {
  const reloaded = vi.fn();
  window.addEventListener("side:host-accounts-changed", reloaded);
  await render();
  await openMenu();
  await act(async () => item("Add account").click());
  expect(requests.at(-1)).toEqual({ method: "accounts.login", params: { accountId: undefined } });
  expect(openUrl).toHaveBeenCalledWith("https://claude.com/cai/oauth/authorize?code=true");
  await typeCode("  abc#state ");
  expect(requests.at(-1)).toEqual({
    method: "accounts.loginCode",
    params: { loginId: "login-1", code: "abc#state" },
  });
  expect(reloaded).toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(requests.some((request) => request.method === "accounts.loginCancel")).toBe(false);
});

it("reconnects a chosen account and shows a refused code", async () => {
  codeResult = () => {
    throw new Error("Login failed: Request failed with status code 400");
  };
  await render();
  await openMenu();
  await act(async () => item("Reconnect").click());
  await act(async () => item("benchoubane.sid").click());
  expect(requests.at(-1)).toEqual({ method: "accounts.login", params: { accountId: "perso-2" } });
  await typeCode("bad");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "Login failed: Request failed with status code 400",
  );
});

it("stops the host's sign-in when it is left midway", async () => {
  await render();
  await openMenu();
  await act(async () => item("Add account").click());
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!.click());
  expect(requests.at(-1)).toEqual({ method: "accounts.loginCancel", params: { loginId: "login-1" } });
});

it("offers signing in only where the host can do it for that provider", async () => {
  await render({ harness: "codex", accounts: [{ id: "work", provider: "codex", label: "Work" }] });
  await openMenu();
  expect(item("Add account")).toBeUndefined();
  await act(async () => root.render(createElement("div")));
  await render({ accounts: [], value: undefined });
  expect(footer.querySelector("button")?.getAttribute("aria-label")).toBe("Host account: Default account");
});

it("imports a profile already signed in on the host", async () => {
  const reloaded = vi.fn();
  window.addEventListener("side:host-accounts-changed", reloaded);
  await render({ canImport: true });
  await openMenu();
  expect(requests.at(-1)).toEqual({ method: "accounts.found", params: {} });
  await act(async () => item("Import work.person").click());
  expect(requests.at(-1)).toEqual({
    method: "accounts.import",
    params: { configDir: "~/.claude-work" },
  });
  expect(reloaded).toHaveBeenCalled();
  expect(item("Import work.person")).toBeUndefined();
});

it("does not look for profiles on a host that cannot import them", async () => {
  await render();
  await openMenu();
  expect(requests.some((request) => request.method === "accounts.found")).toBe(false);
});

it("reads usage afresh when the menu opens, and again on demand", async () => {
  const reloaded = vi.fn();
  window.addEventListener("side:host-accounts-changed", reloaded);
  await render({ canRefresh: true });
  await openMenu();
  const refreshes = () => requests.filter((request) => request.method === "accounts.refresh").length;
  expect(refreshes()).toBe(1);
  expect(reloaded).toHaveBeenCalled();
  await act(async () =>
    document.querySelector<HTMLButtonElement>('button[aria-label="Refresh usage"]')!.click(),
  );
  expect(refreshes()).toBe(2);
});

it("shows a window whose reset has passed as empty, not full", async () => {
  await render({
    value: "perso-2",
    accounts: [
      {
        id: "perso-2",
        provider: "claude",
        label: "benchoubane.sid",
        usage: { fiveHour: { used: 100, resetsAt: Date.now() - 1_000 }, sevenDay: { used: 72 } },
      },
    ],
  });
  const trigger = footer.querySelector("button")!;
  expect(trigger.textContent).toContain("0% 5h");
  expect(trigger.textContent).toContain("72% 7d");
  await openMenu();
  const bars = [...document.querySelectorAll('[role="progressbar"]')].map((bar) =>
    bar.getAttribute("aria-valuenow"),
  );
  expect(bars).toEqual(["0", "72"]);
});

it("says why an account's usage could not be read", async () => {
  await render({
    accounts: [
      { id: "perso-2", provider: "claude", label: "benchoubane.sid", usage: { error: "Not signed in" } },
    ],
  });
  await openMenu();
  expect(document.body.textContent).toContain("Not signed in");
});
