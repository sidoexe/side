import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_TURN_INACTIVE, HostAppBridge } from "./app-bridge";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function bridge(running = new Set<string>(), now = () => Date.now()) {
  const root = mkdtempSync(join(tmpdir(), "side-app-"));
  roots.push(root);
  const path = join(root, "app-access.json");
  return { path, running, app: new HostAppBridge(path, (id) => running.has(id), now) };
}

const call = (token: string, extra: Record<string, unknown> = {}) => ({
  token, action: "sessions.list", input: {}, requestId: "r1", ...extra,
});

it("refuses calls outside an active turn of a thread enabled by /operator", async () => {
  const { app, running } = bridge();
  const token = app.token("s1");
  expect(app.token("s1")).toBe(token);
  expect(await app.request(call("wrong"))).toMatchObject({ ok: false, error: expect.stringContaining("credential") });
  expect(await app.request(call(token))).toEqual({ ok: false, error: APP_TURN_INACTIVE, retryable: false });
  app.enable("s1");
  expect(await app.request(call(token))).toMatchObject({ error: APP_TURN_INACTIVE });
  running.add("s1");
  expect(await app.request(call(token, { requestId: "" }))).toMatchObject({ error: "Invalid input or request ID" });
});

it("hands a call to one desktop and returns its reply to the agent", async () => {
  let at = 1_000;
  const { app, running } = bridge(new Set(["s1"]), () => at);
  app.enable("s1");
  const answer = app.request(call(app.token("s1")));
  const [taken] = app.take("s1", "pro");
  expect(taken).toMatchObject({ sessionId: "s1", action: "sessions.list", requestId: "r1" });
  expect(taken).not.toHaveProperty("resolve");
  // Leased to the Pro: the Air does not get it, nor another session.
  expect(app.take("s1", "air")).toEqual([]);
  expect(app.take("s2", "pro")).toEqual([]);
  at += 41_000;
  expect(app.take("s1", "air")).toHaveLength(1);
  expect(app.reply(taken.id, { ok: true, result: [] })).toBe(true);
  expect(await answer).toEqual({ ok: true, result: [] });
  expect(app.reply(taken.id, { ok: true })).toBe(false);
  running.clear();
});

it("remembers enabled threads across restarts", () => {
  const { app, path, running } = bridge();
  app.enable("s1");
  const again = new HostAppBridge(path, (id) => running.has(id));
  expect(again.enabledFor("s1")).toBe(true);
  expect(again.enabledFor("s2")).toBe(false);
});

it("times a call out when no desktop answers", async () => {
  vi.useFakeTimers();
  const { app } = bridge(new Set(["s1"]));
  app.enable("s1");
  const answer = app.request(call(app.token("s1")));
  await vi.advanceTimersByTimeAsync(35_001);
  expect(await answer).toMatchObject({ ok: false, error: expect.stringContaining("timed out") });
  expect(app.take("s1", "pro")).toEqual([]);
});
