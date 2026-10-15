import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostWebApps } from "./webApps";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function directory() {
  const dir = mkdtempSync(join(tmpdir(), "side-web-apps-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const LINEAR = { id: "default", name: "Linear", url: "https://linear.app/" };
const NOTION = { id: "6f1c2a4e-0b7d-4c55-9a3e-2f8b1d6c7e90", name: "Notion", url: "https://notion.so/" };

describe("web apps", () => {
  it("keeps the newest list, across restarts", () => {
    const dir = directory();
    const store = new HostWebApps(dir);
    store.set({ apps: [LINEAR, NOTION], updatedAt: 20 });
    expect(store.set({ apps: [LINEAR], updatedAt: 10 }).apps).toHaveLength(2);
    expect(new HostWebApps(dir).get()).toEqual({ apps: [LINEAR, NOTION], updatedAt: 20 });
    expect(store.set({ apps: [NOTION], updatedAt: 30 }).apps).toEqual([NOTION]);
  });

  it("refuses what isn't a web app", () => {
    const store = new HostWebApps(directory());
    expect(() => store.set({ apps: [{ ...LINEAR, url: "file:///etc/passwd" }], updatedAt: 1 })).toThrow();
    expect(() => store.set({ apps: [{ ...LINEAR, id: "../../x" }], updatedAt: 1 })).toThrow();
    expect(() => store.set({ apps: [{ ...LINEAR, name: "" }], updatedAt: 1 })).toThrow();
    expect(() => store.set({ apps: "nope", updatedAt: 1 })).toThrow();
  });

  it("keeps the newest login of each app, readable by its owner only", () => {
    const dir = directory();
    const store = new HostWebApps(dir);
    store.set({ apps: [LINEAR, NOTION], updatedAt: 1 });
    expect(store.session({ id: "default" })).toBeNull();
    store.setSession({ id: "default", cookies: ["a=1; Secure; HttpOnly"], updatedAt: 5 });
    expect(store.setSession({ id: "default", cookies: ["a=old"], updatedAt: 4 })?.cookies).toEqual([
      "a=1; Secure; HttpOnly",
    ]);
    expect(new HostWebApps(dir).session({ id: "default" })?.cookies).toEqual(["a=1; Secure; HttpOnly"]);
    expect(statSync(join(dir, "web-sessions.json")).mode & 0o777).toBe(0o600);
    expect(() => store.setSession({ id: "11111111-2222-4333-8444-555555555555", cookies: [], updatedAt: 9 })).toThrow();
  });

  it("drops a removed app's login", () => {
    const store = new HostWebApps(directory());
    store.set({ apps: [LINEAR, NOTION], updatedAt: 1 });
    store.setSession({ id: NOTION.id, cookies: ["s=1"], updatedAt: 2 });
    store.set({ apps: [LINEAR], updatedAt: 3 });
    expect(store.session({ id: NOTION.id })).toBeNull();
  });
});
