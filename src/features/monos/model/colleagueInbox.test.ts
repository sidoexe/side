import { expect, it, vi } from "vitest";
import type { RemoteMachine } from "../../connections/model/protocol";
import { deliverInbox, type InboxMessage } from "./colleagueInbox";

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
