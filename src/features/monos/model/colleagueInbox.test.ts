import { expect, it, vi } from "vitest";
import type { RemoteMachine } from "../../connections/model/protocol";
import { colleagueUsage, deliverInbox, publishAccounts, type InboxMessage } from "./colleagueInbox";
import { idleRateLimits } from "../../providers/model/rateLimits";

const home = { id: "home" } as RemoteMachine;

function host(waiting: InboxMessage[], taken: (id: string) => boolean = () => true) {
  const delivered: string[] = [];
  const request = vi.fn(async (_machine: RemoteMachine, method: string, params?: unknown) => {
    const { id } = (params ?? {}) as { id?: string };
    if (method === "employees.waiting") return waiting;
    if (method === "employees.take") return taken(id!);
    if (method === "employees.delivered") delivered.push(id!);
    return null;
  }) as never;
  return { request, delivered };
}

const message = (id: string, mono: string, text = id): InboxMessage => ({ id, mono, text, at: 0 });

it("sends each message it takes to its colleague, in order", async () => {
  const { request, delivered } = host([message("1", "a"), message("2", "b"), message("3", "a")]);
  const sent: string[] = [];
  const count = await deliverInbox(request, home, "me", async (mono, text) => {
    sent.push(`${mono}:${text}`);
    return true;
  }, () => true);
  expect(count).toBe(3);
  expect(sent).toEqual(["a:1", "b:2", "a:3"]);
  expect(delivered).toEqual(["1", "2", "3"]);
});

it("holds a colleague's later messages when one cannot go", async () => {
  const { request, delivered } = host([message("1", "a"), message("2", "a"), message("3", "b")]);
  const sent: string[] = [];
  await deliverInbox(request, home, "me", async (mono, text) => {
    sent.push(text);
    return text !== "1";
  }, () => true);
  expect(sent).toEqual(["1", "3"]);
  expect(delivered).toEqual(["3"]);
});

it("leaves messages another desktop took, or for colleagues it lacks", async () => {
  const { request, delivered } = host([message("1", "a"), message("2", "b")], (id) => id !== "1");
  const deliver = vi.fn(async () => true);
  await deliverInbox(request, home, "me", deliver, (mono) => mono !== "b");
  expect(deliver).not.toHaveBeenCalled();
  expect(delivered).toEqual([]);
});

it("hands an account move to the desktop instead of a message", async () => {
  const { request, delivered } = host([{ id: "1", mono: "a", text: "", account: "account-work", at: 0 }]);
  const calls: unknown[][] = [];
  await deliverInbox(request, home, "me", async (...args) => {
    calls.push(args);
    return true;
  }, () => true);
  expect(calls).toEqual([["a", "", "account-work", undefined, undefined]]);
  expect(delivered).toEqual(["1"]);
});

it("publishes the accounts only when they changed", async () => {
  const { request } = host([]);
  const accounts = {
    accounts: [{ provider: "claude", id: "default", label: "Personal" }],
    current: { a: { provider: "claude", account: "default" } },
    status: { a: { status: "idle" as const } },
    threads: {},
  };
  const first = await publishAccounts(request, home, accounts, undefined);
  await publishAccounts(request, home, accounts, first);
  const calls = (request as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  expect(calls.filter(([, method]) => method === "employees.setAccounts")).toHaveLength(1);
});

it("reports an account's plan windows once they were read", () => {
  expect(colleagueUsage(idleRateLimits("claude"))).toBeUndefined();
  expect(
    colleagueUsage({
      ...idleRateLimits("claude"),
      session: { usedPercent: 81.6, windowMinutes: 300, resetsAt: 5 },
      weekly: { usedPercent: 59, windowMinutes: 10080, resetsAt: null },
      updatedAt: 9,
    }),
  ).toEqual({ session: { used: 82, resetsAt: 5 }, weekly: { used: 59, resetsAt: null }, updatedAt: 9 });
});

it("hands a message for another thread to the desktop with that thread", async () => {
  const { request } = host([{ id: "1", mono: "a", text: "hi", thread: "t2", at: 0 }]);
  const calls: unknown[][] = [];
  await deliverInbox(request, home, "me", async (...args) => {
    calls.push(args);
    return true;
  }, () => true);
  expect(calls).toEqual([["a", "hi", undefined, "t2", undefined]]);
});

it("hands a stop or a steer to the desktop with the message", async () => {
  const { request } = host([
    { id: "1", mono: "a", text: "", control: "stop", at: 0 },
    { id: "2", mono: "a", text: "go", control: "steer", thread: "t2", at: 0 },
  ]);
  const calls: unknown[][] = [];
  await deliverInbox(request, home, "me", async (...args) => {
    calls.push(args);
    return true;
  }, () => true);
  expect(calls).toEqual([
    ["a", "", undefined, undefined, "stop"],
    ["a", "go", undefined, "t2", "steer"],
  ]);
});
