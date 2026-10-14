import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { HostRail } from "./rail";
import { HostEngine } from "./engine";
import { HostStore } from "./store";
import { createHostServer } from "./server";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function directory() {
  const dir = mkdtempSync(join(tmpdir(), "side-rail-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("project rail", () => {
  it("keeps the rail and archive the desktop sends, across restarts", () => {
    const dir = directory();
    const rail = new HostRail(dir);
    rail.set({ projects: ["/a/app", "/a/side/", "/a/app"], archived: ["/a/old", "/a/side"] });
    expect(new HostRail(dir).get()).toMatchObject({ projects: ["/a/app", "/a/side"], archived: ["/a/old"] });
    expect(() => rail.set({ projects: ["relative/path"] })).toThrow();
    expect(() => rail.set({ projects: "nope" })).toThrow();
  });

  it("stores one background image per folder", () => {
    const rail = new HostRail(directory());
    expect(() => rail.setBackground({ cwd: "/a/app", mimeType: "text/html", data: PNG.toString("base64") })).toThrow();
    rail.setBackground({ cwd: "/a/app", mimeType: "image/png", data: PNG.toString("base64") });
    expect(rail.background("/a/app")?.type).toBe("image/png");
    rail.setBackground({ cwd: "/a/app", mimeType: "image/jpeg", data: PNG.toString("base64") });
    expect(rail.background("/a/app")?.type).toBe("image/jpeg");
    rail.clearBackground({ cwd: "/a/app" });
    expect(rail.background("/a/app")).toBeUndefined();
    expect(rail.get().backgrounds).toEqual({});
  });

  it("serves a background only to a signed-in browser", async () => {
    const dir = directory();
    const store = new HostStore(join(dir, "host.db"));
    const engine = new HostEngine(store, {});
    engine.rail = new HostRail(join(dir, "rail"));
    engine.rail.setBackground({ cwd: "/a/app", mimeType: "image/png", data: PNG.toString("base64") });
    const server = createHostServer(engine, ["codex"]);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.unshift(async () => {
      await engine.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const device = store.issueDevice("Web");
    const url = `${base}/web/background?cwd=${encodeURIComponent("/a/app")}`;
    expect((await fetch(url)).status).toBe(401);
    const ok = await fetch(url, { headers: { Cookie: `side_host=${device.token}` } });
    expect(ok.status).toBe(200);
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(PNG);
    const missing = await fetch(`${base}/web/background?cwd=%2Fother`, { headers: { Cookie: `side_host=${device.token}` } });
    expect(missing.status).toBe(404);
  });
});
