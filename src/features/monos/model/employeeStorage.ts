import { invoke } from "@tauri-apps/api/core";
import { loadRemoteMachines, remoteRequest } from "../../connections/model/connections";
import { resolveHomeMachine } from "../../connections/model/homeMachine";
import type { HostDescriptor, RemoteMachine } from "../../connections/model/protocol";

/**
 * Where employees' files live. With a home machine whose host keeps them,
 * every desktop reads and writes that host's copy, so they share one soul,
 * one memory and one `habits.json`; the hash-checked save then makes a habit
 * run once across every desktop. Without one, this computer's data folder is
 * used, as before.
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
const capable = new Map<string, Promise<boolean>>();

/** The home machine, when its host keeps employees. */
export async function employeeHome(): Promise<RemoteMachine | undefined> {
  const home = resolveHomeMachine(await loadRemoteMachines());
  if (!home) return undefined;
  let check = capable.get(home.id);
  if (!check) {
    check = remoteRequest<HostDescriptor>(home.id, "environment.describe").then(
      (descriptor) => descriptor.capabilities?.includes("employees") === true,
    );
    capable.set(home.id, check);
    // An unreachable host is asked again next time rather than written off.
    check.catch(() => capable.delete(home.id));
  }
  return (await check) ? home : undefined;
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
      const local = { mono, legacyProject };
      const loaded = await invoke<EmployeeFilesRecord>("mono_load", local);
      const files: Record<string, string> = {};
      if (loaded.soul != null) files["SOUL.md"] = loaded.soul;
      if (loaded.memory) files["MEMORY.md"] = loaded.memory;
      for (const path of [
        "habits.json",
        "memory/archive.md",
        ...loaded.topics.map((topic) => `memory/${topic}.md`),
      ]) {
        const file = await invoke<EmployeeFileRecord>("mono_read", { ...local, path });
        if (file.text != null) files[path] = file.text;
      }
      await remoteRequest(home.id, "employees.import", { mono, files });
      try {
        localStorage.setItem(IMPORTED_KEY, JSON.stringify({ ...readImported(), [key]: true }));
      } catch {
        /* imported again next time; the host keeps its own copy */
      }
    })().finally(() => importing.delete(key));
    importing.set(key, pending);
  }
  return pending;
}

export async function loadEmployeeFiles(
  mono: string,
  legacyProject: string | null,
): Promise<EmployeeFilesRecord> {
  const home = await employeeHome();
  if (!home) return invoke("mono_load", { mono, legacyProject });
  await importOnce(home, mono, legacyProject);
  return remoteRequest(home.id, "employees.load", { mono });
}

export async function readEmployeeFile(
  mono: string,
  legacyProject: string | null,
  path: string,
): Promise<EmployeeFileRecord> {
  const home = await employeeHome();
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
  const home = await employeeHome();
  if (!home) return invoke("mono_save", { mono, legacyProject, path, text, expectedHash });
  await importOnce(home, mono, legacyProject);
  return remoteRequest<string>(home.id, "employees.save", { mono, path, text, expectedHash })
    .catch(sameErrors);
}
