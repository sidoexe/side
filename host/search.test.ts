import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { HostStore } from "./store";
import { searchHostSessions } from "./search";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function store() {
  const directory = mkdtempSync(join(tmpdir(), "host-search-"));
  const store = new HostStore(join(directory, "host.db"));
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const project = store.addProject(directory, "repo");
  const save = (id: string, title: string, texts: string[], extra: Record<string, unknown> = {}, updatedAt = 1) =>
    store.save(
      {
        projectId: project.id,
        revision: 1,
        status: "idle",
        updatedAt,
        ...extra,
        session: {
          id,
          harness: "codex",
          model: "codex:test",
          runtimeMode: "supervised",
          title,
          cwd: directory,
          blocks: texts.map((text, index) => ({ id: `${id}-${index}`, role: index % 2 ? "assistant" : "user", text })),
        },
      } as never,
      { type: "test" },
    );
  return { store, project, save };
}

it("finds conversations by title and by what was said, newest first", () => {
  const { store: s, project, save } = store();
  save("old", "Fix the login", ["Please fix login", "Done, login works"], {}, 1);
  save("new", "Dark mode", ["Add a toggle", "The login page has it too"], {}, 2);
  const { hits, truncated } = searchHostSessions(s, "LOGIN");
  expect(truncated).toBe(false);
  expect(hits.map((hit) => [hit.sessionId, hit.kind])).toEqual([
    ["new", "message"],
    ["old", "conversation"],
    ["old", "message"],
    ["old", "message"],
  ]);
  expect(hits[0]).toMatchObject({ projectId: project.id, cwd: project.cwd, blockId: "new-1", role: "assistant", preview: "The login page has it too" });
});

it("leaves archived conversations and empty queries out", () => {
  const { store: s, save } = store();
  save("gone", "Login", ["login"], { archived: true });
  expect(searchHostSessions(s, "login").hits).toEqual([]);
  expect(searchHostSessions(s, "  ").hits).toEqual([]);
});
