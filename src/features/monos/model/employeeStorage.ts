import { invoke } from "@tauri-apps/api/core";
import { remoteRequest } from "../../connections/model/connections";
import { homeWith } from "../../connections/model/homeCapability";
import type { RemoteMachine } from "../../connections/model/protocol";
import { findMono } from "./mono";

/**
 * Where employees' files live. With a home machine whose host keeps them,
 * every desktop reads and writes that host's copy, so they share one soul,
 * one memory and one `habits.json`; the hash-checked save then makes a habit
 * run once across every desktop. Without one, or for an employee kept on
 * this computer only, this computer's data folder is used, as before.
 */

export type EmployeeFilesRecord = {
  id: string;
  dir: string;
  soul: string | null;
  soulHash: string;
  memory: string;
  memoryHash: string;
  memoryPath: string;
  topics: string[];
};

export type EmployeeFileRecord = { text: string | null; hash: string };

const IMPORTED_KEY = "side.employeesImported.v1";

/** The home machine, when its host keeps employees. */
export function employeeHome(): Promise<RemoteMachine | undefined> {
  return homeWith("employees");
}

/** Where this employee's files live: the home machine's host, unless it is
 * kept on this computer only. */
function homeFor(mono: string): Promise<RemoteMachine | undefined> {
  return findMono(mono)?.localOnly ? Promise.resolve(undefined) : employeeHome();
}

/** The host's refusal of a stale save reads as the local store's. */
function sameErrors(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/(^|: )conflict$/.test(message)) throw "conflict";
  throw error;
}

function readImported(): Record<string, true> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(IMPORTED_KEY) ?? "{}");
    return value && typeof value === "object" ? (value as Record<string, true>) : {};
  } catch {
    return {};
  }
}

/** Every file an employee has, by path, read through `load` and `read`. */
async function filesOf(
  load: () => Promise<EmployeeFilesRecord>,
  read: (path: string) => Promise<EmployeeFileRecord>,
): Promise<Record<string, string>> {
  const loaded = await load();
  const files: Record<string, string> = {};
  if (loaded.soul != null) files["SOUL.md"] = loaded.soul;
  if (loaded.memory) files["MEMORY.md"] = loaded.memory;
  for (const path of [
    "habits.json",
    "memory/archive.md",
    ...loaded.topics.map((topic) => `memory/${topic}.md`),
  ]) {
    const file = await read(path);
    if (file.text != null) files[path] = file.text;
  }
  return files;
}

function markImported(key: string): void {
  try {
    localStorage.setItem(IMPORTED_KEY, JSON.stringify({ ...readImported(), [key]: true }));
  } catch {
    /* imported again next time; the host keeps its own copy */
  }
}

const importing = new Map<string, Promise<void>>();

/** Copies this computer's files for one employee to the host, once. The host
 * keeps what it already has, so a second desktop never overwrites the first. */
function importOnce(
  home: RemoteMachine,
  mono: string,
  legacyProject: string | null,
): Promise<void> {
  const key = `${home.environmentId}:${mono}`;
  if (readImported()[key]) return Promise.resolve();
  let pending = importing.get(key);
  if (!pending) {
    pending = (async () => {
      const files = await filesOf(
        () => invoke<EmployeeFilesRecord>("mono_load", { mono, legacyProject }),
        (path) => invoke<EmployeeFileRecord>("mono_read", { mono, legacyProject, path }),
      );
      await remoteRequest(home.id, "employees.import", { mono, files });
      markImported(key);
    })().finally(() => importing.delete(key));
    importing.set(key, pending);
  }
  return pending;
}

export async function loadEmployeeFiles(
  mono: string,
  legacyProject: string | null,
): Promise<EmployeeFilesRecord> {
  const home = await homeFor(mono);
  if (!home) return invoke("mono_load", { mono, legacyProject });
  await importOnce(home, mono, legacyProject);
  return remoteRequest(home.id, "employees.load", { mono });
}

export async function readEmployeeFile(
  mono: string,
  legacyProject: string | null,
  path: string,
): Promise<EmployeeFileRecord> {
  const home = await homeFor(mono);
  if (!home) return invoke("mono_read", { mono, legacyProject, path });
  await importOnce(home, mono, legacyProject);
  return remoteRequest(home.id, "employees.read", { mono, path });
}

/** Rejects with `"conflict"` when the file moved since `expectedHash`. */
export async function saveEmployeeFile(
  mono: string,
  legacyProject: string | null,
  path: string,
  text: string,
  expectedHash: string | null,
): Promise<string> {
  const home = await homeFor(mono);
  if (!home) return invoke("mono_save", { mono, legacyProject, path, text, expectedHash });
  await importOnce(home, mono, legacyProject);
  return remoteRequest<string>(home.id, "employees.save", { mono, path, text, expectedHash })
    .catch(sameErrors);
}

/** Writes this computer's files over the host's, when the employee becomes
 * shared. Files only the host has are left there. */
export async function copyFilesToHost(
  home: RemoteMachine,
  mono: string,
  legacyProject: string | null,
): Promise<void> {
  const files = await filesOf(
    () => invoke<EmployeeFilesRecord>("mono_load", { mono, legacyProject }),
    (path) => invoke<EmployeeFileRecord>("mono_read", { mono, legacyProject, path }),
  );
  for (const [path, text] of Object.entries(files))
    await remoteRequest(home.id, "employees.save", { mono, path, text, expectedHash: null });
  markImported(`${home.environmentId}:${mono}`);
}

/** Writes the host's files over this computer's, when the employee stays
 * here only. */
export async function copyFilesHere(
  home: RemoteMachine,
  mono: string,
  legacyProject: string | null,
): Promise<void> {
  await importOnce(home, mono, legacyProject);
  const files = await filesOf(
    () => remoteRequest<EmployeeFilesRecord>(home.id, "employees.load", { mono }),
    (path) => remoteRequest<EmployeeFileRecord>(home.id, "employees.read", { mono, path }),
  );
  for (const [path, text] of Object.entries(files))
    await invoke("mono_save", { mono, legacyProject, path, text, expectedHash: null });
}
