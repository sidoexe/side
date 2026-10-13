import { afterEach, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash, EMPLOYEE_CONFLICT, HostEmployees } from "./employees";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function employees() {
  const root = mkdtempSync(join(tmpdir(), "side-employees-"));
  roots.push(root);
  return { root, store: new HostEmployees(join(root, "employees")) };
}

it("creates one folder per employee with an empty memory", () => {
  const { store } = employees();
  const first = store.load("emp-a");
  expect(store.load("emp-a").dir).toBe(first.dir);
  expect(store.load("emp-b").dir).not.toBe(first.dir);
  expect(first).toMatchObject({ id: "emp-a", soul: null, memory: "", topics: [] });
  expect(first.soulHash).toBe(contentHash(""));
  expect(existsSync(join(first.dir, "memory"))).toBe(true);
  expect(() => store.load("../x")).toThrow("Invalid employee ID");
});

it("refuses to save over a file that changed since it was read", () => {
  const { store } = employees();
  const files = store.load("m");
  const hash = store.save("m", "MEMORY.md", "- a", files.memoryHash);
  expect(() => store.save("m", "MEMORY.md", "- b", files.memoryHash)).toThrow(EMPLOYEE_CONFLICT);
  store.save("m", "MEMORY.md", "- c", hash);
  store.save("m", "SOUL.md", "soul", undefined);
  expect(store.load("m")).toMatchObject({ memory: "- c", soul: "soul" });
});

it("lets only one of several claims over the same habits version through", () => {
  const { store } = employees();
  const hash = store.save("m", "habits.json", "[]", undefined);
  const results = Array.from({ length: 8 }, (_, index) => {
    try {
      store.save("m", "habits.json", `[{"claimedBy":${index}}]`, hash);
      return index;
    } catch (error) {
      expect((error as Error).message).toBe(EMPLOYEE_CONFLICT);
      return undefined;
    }
  });
  expect(results.filter((value) => value !== undefined)).toEqual([0]);
  expect(store.read("m", "habits.json").text).toBe('[{"claimedBy":0}]');
});

it("reads and writes topics inside the folder only", () => {
  const { store } = employees();
  store.save("m", "memory/releases.md", "# Releases", undefined);
  store.save("m", "memory/archive.md", "- old", undefined);
  expect(store.load("m").topics).toEqual(["releases"]);
  expect(store.read("m", "memory/releases.md").text).toBe("# Releases");
  expect(store.read("m", "memory/none.md")).toEqual({ text: null, hash: contentHash("") });
  for (const path of ["../x.md", "memory/../SOUL.md", "memory/a/b.md", "memory/.hidden.md", "notes.md"])
    expect(() => store.save("m", path, "x", undefined), path).toThrow();
});

it("keeps employee files private", () => {
  const { store } = employees();
  store.save("m", "MEMORY.md", "private", undefined);
  expect(statSync(store.load("m").memoryPath).mode & 0o777).toBe(0o600);
});

it("imports a desktop's files without replacing what the host has", () => {
  const { store } = employees();
  store.save("m", "MEMORY.md", "- host", undefined);
  expect(
    store.import("m", {
      "MEMORY.md": "- desktop",
      "SOUL.md": "# Soul",
      "memory/notes.md": "notes",
      "habits.json": 42,
    }),
  ).toEqual({ written: 2 });
  expect(store.load("m")).toMatchObject({ memory: "- host", soul: "# Soul", topics: ["notes"] });
  expect(() => store.import("m", { "../escape.md": "x" })).toThrow();
});

it("replaces the roster only over the revision the writer read", () => {
  const { root, store } = employees();
  expect(store.roster()).toEqual({ revision: 0, roster: [] });
  const first = store.saveRoster([{ id: "a", projects: [] }], 0);
  expect(first.revision).toBe(1);
  expect(() => store.saveRoster([{ id: "b" }], 0)).toThrow(EMPLOYEE_CONFLICT);
  expect(() => store.saveRoster([{ id: "../b" }], 1)).toThrow("Invalid employee roster");
  expect(store.saveRoster([{ id: "a" }, { id: "b" }], 1).revision).toBe(2);
  expect(JSON.parse(readFileSync(join(root, "employees", "roster.json"), "utf8")).roster).toHaveLength(2);
  writeFileSync(join(root, "employees", "roster.json"), "{broken");
  expect(store.roster()).toEqual({ revision: 0, roster: [] });
});
