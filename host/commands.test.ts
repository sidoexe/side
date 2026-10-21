import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { HostStore } from "./store";
import { listHostCommands } from "./commands";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function store() {
  const directory = mkdtempSync(join(tmpdir(), "host-commands-"));
  const project = join(directory, "repo");
  mkdirSync(join(project, "src"), { recursive: true });
  const store = new HostStore(join(directory, "host.db"));
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.addProject(project, "repo");
  return { store, directory, project };
}

it("lists nothing for an agent whose commands are skill files", async () => {
  const { store: s, project } = store();
  expect(await listHostCommands(s, "claude", project, undefined)).toEqual([]);
});

it("only looks inside this host's projects", async () => {
  const { store: s, directory, project } = store();
  await expect(listHostCommands(s, "devin", directory, undefined)).rejects.toThrow(/not in a project/);
  await expect(listHostCommands(s, "devin", "relative/path", undefined)).rejects.toThrow(/Invalid folder/);
  // Devin advertises its commands in a running conversation; none runs here.
  expect(await listHostCommands(s, "devin", join(project, "src"), "no-session")).toEqual([]);
});
