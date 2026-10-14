import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { HostEngine } from "./engine";
import { HostStore } from "./store";
import { createHostServer } from "./server";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "side-web-test-"));
  const root = join(directory, "web");
  mkdirSync(root);
  writeFileSync(join(root, "index.html"), "<!doctype html>app");
  writeFileSync(join(directory, "secret.html"), "secret");
  const store = new HostStore(join(directory, "host.db"));
  const engine = new HostEngine(store, {});
  const project = await engine.openProject(directory);
  const server = createHostServer(engine, ["codex"], undefined, undefined, root);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const base = `http://${host}`;
  const device = store.issueDevice("Web");
  cleanups.push(async () => {
    await engine.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const rpc = (method: string, headers: Record<string, string>) =>
    fetch(`${base}/web/rpc`, {
      method: "POST",
      headers,
      body: JSON.stringify({ version: 1, environmentId: store.environmentId, method, params: {} }),
    });
  const login = (token: string, origin = base) =>
    fetch(`${base}/web/login`, { method: "POST", headers: { Origin: origin }, body: JSON.stringify({ token }) });
  return { base, host, store, project, device, rpc, login };
}

describe("browser app", () => {
  it("serves its page and nothing outside its folder", async () => {
    const s = await setup();
    const page = await fetch(`${s.base}/web/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain("app");
    for (const path of ["/web/../secret.html", "/web/%2e%2e%2fsecret.html", "/web/..%2Fsecret.html", "/web/missing.js"])
      expect([403, 404]).toContain((await fetch(`${s.base}${path}`)).status);
    expect((await fetch(`${s.base}/web`, { redirect: "manual" })).headers.get("location")).toBe("/web/");
  });

  it("signs in with a device credential and keeps it in an HttpOnly cookie", async () => {
    const s = await setup();
    expect((await s.login("x".repeat(43))).status).toBe(401);
    expect((await s.login(s.device.token, "https://evil.example")).status).toBe(403);
    const response = await s.login(s.device.token);
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/web/);
    const session = cookie.split(";")[0];

    const ok = await s.rpc("projects.list", { Origin: s.base, Cookie: session });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { result: { id: string }[] }).result.map((p) => p.id)).toEqual([s.project.id]);
  });

  it("answers only its own page, with a live credential", async () => {
    const s = await setup();
    const session = `side_host=${s.device.token}`;
    expect((await s.rpc("projects.list", { Origin: s.base })).status).toBe(401);
    expect((await s.rpc("projects.list", { Cookie: session })).status).toBe(403);
    expect((await s.rpc("projects.list", { Origin: "https://evil.example", Cookie: session })).status).toBe(403);
    // Behind `tailscale serve` the page's name arrives as X-Forwarded-Host.
    expect(
      (await s.rpc("projects.list", {
        Origin: "https://mac.tailnet.ts.net",
        "X-Forwarded-Host": "mac.tailnet.ts.net",
        Cookie: session,
      })).status,
    ).toBe(200);
    s.store.revokeToken(s.device.token);
    expect((await s.rpc("projects.list", { Origin: s.base, Cookie: session })).status).toBe(401);
  });

  it("keeps the desktop endpoint closed to browsers", async () => {
    const s = await setup();
    const response = await fetch(`${s.base}/rpc`, {
      method: "POST",
      headers: { Origin: s.base, Cookie: `side_host=${s.device.token}`, Authorization: `Bearer ${s.device.token}` },
      body: JSON.stringify({ version: 1, environmentId: s.store.environmentId, method: "projects.list", params: {} }),
    });
    expect(response.status).toBe(403);
  });
});
