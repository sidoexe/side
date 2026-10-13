// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import {
  homeMachineChoice,
  isLoopbackMachine,
  migrateProjectToHome,
  migratedProjects,
  openOnHomeMachine,
  projectsToMigrate,
  recordMigratedProject,
  resolveHomeMachine,
  retargetOpenSessions,
  setHomeMachine,
} from "./homeMachine";
import { newDefaultSession, type Session } from "../../sessions/model/session";
import type { SessionSummary } from "../../sessions/data/sessionStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../monos/model/mono", () => ({
  isMonoSession: (id: string) => id.startsWith("mono-"),
}));

const machine = (id: string, target?: string) => ({
  id,
  name: id,
  endpoint: target ? `ssh://${target}` : "http://127.0.0.1:3774",
  environmentId: `env-${id}`,
  ssh: target ? { target, remotePort: 3774 } : null,
});

beforeEach(() => localStorage.clear());

it("uses the only connected machine until another choice is saved", () => {
  const pro = machine("pro", "sido@localhost");
  const air = machine("air", "me@air");
  expect(homeMachineChoice()).toBeUndefined();
  expect(resolveHomeMachine([pro])).toBe(pro);
  expect(resolveHomeMachine([pro, air])).toBeUndefined();
  setHomeMachine("env-air");
  expect(resolveHomeMachine([pro, air])).toBe(air);
  setHomeMachine(null);
  expect(homeMachineChoice()).toBeNull();
  expect(resolveHomeMachine([pro])).toBeUndefined();
  setHomeMachine(undefined);
  expect(resolveHomeMachine([pro])).toBe(pro);
});

it("treats only SSH targets on this computer as local hosts", () => {
  expect(isLoopbackMachine(machine("a", "sido@localhost"))).toBe(true);
  expect(isLoopbackMachine(machine("b", "127.0.0.1"))).toBe(true);
  expect(isLoopbackMachine(machine("c", "me@[::1]"))).toBe(true);
  expect(isLoopbackMachine(machine("d", "sid@macbook.tail.ts.net"))).toBe(false);
  // A loopback URL can be a tunnel to anywhere.
  expect(isLoopbackMachine(machine("e"))).toBe(false);
});

it("migrates each local project once and never a remote or home folder", () => {
  const paths = ["/Users/me/app", "remote://env/x", "~", "/Users/me/app", "/Users/me/db"];
  expect(projectsToMigrate(paths)).toEqual(["/Users/me/app", "/Users/me/db"]);
  recordMigratedProject("/Users/me/app", "remote://env/Users/me/app");
  expect(projectsToMigrate(paths)).toEqual(["/Users/me/db"]);
  expect(migratedProjects()).toEqual({ "/Users/me/app": "remote://env/Users/me/app" });
});

const chat = (id: string, cwd: string, extra: Partial<Session> = {}): Session => ({
  ...newDefaultSession(cwd),
  id,
  blocks: [{ id: `${id}-u`, role: "user", text: "hi" } as Session["blocks"][number]],
  ...extra,
});

it("imports a project's saved chats and skips employees, drafts and blank ones", async () => {
  const summaries = [
    { id: "a", createdAt: 1, updatedAt: 2, pinned: true },
    { id: "b", createdAt: 3, updatedAt: 4 },
    { id: "mono-x", createdAt: 5, updatedAt: 6 },
    { id: "draft", createdAt: 7, updatedAt: 8, draft: true },
    { id: "blank", createdAt: 9, updatedAt: 10 },
    { id: "broken", createdAt: 11, updatedAt: 12 },
  ] as SessionSummary[];
  const importSession = vi.fn(async ({ session }: { session: Session }) => {
    if (session.id === "broken") throw new Error("host refused");
    return { imported: session.id === "a" };
  });
  const result = await migrateProjectToHome({ environmentId: "env" }, "/Users/me/app", {
    openProject: async (cwd) => ({ id: "p1", cwd, name: "app" }),
    listSessions: async () => summaries,
    getSession: async (id) =>
      id === "blank" ? { ...newDefaultSession("/Users/me/app"), id } : chat(id, "/Users/me/app"),
    importSession,
  });
  expect(result).toEqual({
    kind: "moved",
    project: { id: "p1", cwd: "/Users/me/app", name: "app" },
    key: "remote://env/Users/me/app",
    imported: 1,
    skipped: 1,
    failed: ["broken"],
  });
  expect(importSession.mock.calls.map(([params]) => params.session.id)).toEqual(["a", "b", "broken"]);
  expect(importSession.mock.calls[0][0]).toMatchObject({ projectId: "p1", createdAt: 1, updatedAt: 2, pinned: true });
});

it("reports a folder the host does not have", async () => {
  const result = await migrateProjectToHome({ environmentId: "env" }, "/Users/air/only-here", {
    openProject: async () => {
      throw new Error("ENOENT: no such file or directory");
    },
    listSessions: async () => [],
    getSession: async () => null,
    importSession: async () => ({ imported: true }),
  });
  expect(result).toEqual({ kind: "missing", error: "ENOENT: no such file or directory" });
});

it("turns a moved project's open tabs into host tabs in place", () => {
  const sessions = [
    chat("saved", "/Users/me/app"),
    { ...newDefaultSession("/Users/me/app"), id: "blank" },
    chat("other", "/Users/me/db"),
    chat("mono-1", "/Users/me/app"),
  ];
  const result = retargetOpenSessions(sessions, "/Users/me/app", "remote://env/Users/me/app", (cwd) =>
    newDefaultSession(cwd),
  );
  expect(result.blocked).toBe(false);
  expect(result.remote).toEqual(["saved"]);
  expect(result.sessions.map((session) => [session.id, session.cwd, session.blocks.length])).toEqual([
    ["saved", "remote://env/Users/me/app", 0],
    ["blank", "remote://env/Users/me/app", 0],
    ["other", "/Users/me/db", 1],
    ["mono-1", "/Users/me/app", 1],
  ]);
  const busy = retargetOpenSessions([chat("run", "/Users/me/app", { busy: true })], "/Users/me/app", "k", (cwd) =>
    newDefaultSession(cwd),
  );
  expect(busy.blocked).toBe(true);
});

it("opens picked folders on the home machine and reports the missing ones", async () => {
  const pro = machine("pro", "sido@localhost");
  const result = await openOnHomeMachine(pro, ["/Users/me/app", "/nope"], async (cwd) => {
    if (cwd === "/nope") throw new Error("missing");
    return { id: "p", cwd, name: "app" };
  });
  expect(result).toEqual({ keys: ["remote://env-pro/Users/me/app"], failed: ["/nope"] });
});
