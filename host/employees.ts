import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Employees' files on the home machine, so every desktop reads the same soul,
 * memory and habits. Mirrors `src-tauri/src/mono.rs`: one folder per employee
 * id, a fixed set of files inside it, and saves checked against the hash the
 * writer read. That check is what lets a habit run once across every
 * desktop: each one claims it by saving `habits.json` over the version it
 * read, and only the first save wins.
 *
 * ```text
 * <data dir>/employees/
 * ├── roster.json       every employee's look and projects, with a revision
 * └── <employee id>/
 *     ├── SOUL.md
 *     ├── MEMORY.md
 *     ├── habits.json
 *     └── memory/       topic notes, and archive.md
 * ```
 */

const SOUL_FILE = "SOUL.md";
const MEMORY_FILE = "MEMORY.md";
const HABITS_FILE = "habits.json";
const MEMORY_DIR = "memory";
const ROSTER_FILE = "roster.json";
const FILE_MAX = 256 * 1024;
const ROSTER_MAX = 512 * 1024;
const ID = /^[A-Za-z0-9-]{1,80}$/;
const TOPIC = /^[A-Za-z0-9 ._-]{1,80}$/;

export const EMPLOYEE_CONFLICT = "conflict";

export type EmployeeFiles = {
  id: string;
  dir: string;
  soul: string | null;
  soulHash: string;
  memory: string;
  memoryHash: string;
  memoryPath: string;
  topics: string[];
};

export type EmployeeRoster = { revision: number; roster: unknown[] };

export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function writeAtomic(path: string, text: string): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, path);
}

/** SOUL.md, MEMORY.md, habits.json or one `memory/<name>.md`: nothing nested,
 * nothing hidden, so no path can leave the employee's folder. */
function resolveFile(dir: string, relative: unknown): string {
  if (typeof relative !== "string") throw new Error("Not an employee file");
  if (relative === SOUL_FILE || relative === MEMORY_FILE || relative === HABITS_FILE)
    return join(dir, relative);
  const name = relative.startsWith(`${MEMORY_DIR}/`) && relative.endsWith(".md")
    ? relative.slice(MEMORY_DIR.length + 1, -3)
    : "";
  if (!TOPIC.test(name) || name.startsWith("."))
    throw new Error(`Not an employee file: ${relative}`);
  return join(dir, MEMORY_DIR, `${name}.md`);
}

export class HostEmployees {
  constructor(private readonly root: string) {}

  private dir(id: unknown): string {
    if (typeof id !== "string" || !ID.test(id)) throw new Error("Invalid employee ID");
    const dir = join(this.root, id);
    mkdirSync(join(dir, MEMORY_DIR), { recursive: true, mode: 0o700 });
    return dir;
  }

  private topics(dir: string): string[] {
    try {
      return readdirSync(join(dir, MEMORY_DIR))
        .filter((name) => name.endsWith(".md") && !name.startsWith("."))
        .filter((name) => statSync(join(dir, MEMORY_DIR, name)).isFile())
        .map((name) => name.slice(0, -3))
        .filter((topic) => topic !== "archive")
        .sort();
    } catch {
      return [];
    }
  }

  load(id: unknown): EmployeeFiles {
    const dir = this.dir(id);
    const soul = readOptional(join(dir, SOUL_FILE));
    const memoryPath = join(dir, MEMORY_FILE);
    const memory = readOptional(memoryPath) ?? "";
    return {
      id: id as string,
      dir,
      soul,
      soulHash: contentHash(soul ?? ""),
      memory,
      memoryHash: contentHash(memory),
      memoryPath,
      topics: this.topics(dir),
    };
  }

  read(id: unknown, path: unknown): { text: string | null; hash: string } {
    const text = readOptional(resolveFile(this.dir(id), path));
    return { text, hash: contentHash(text ?? "") };
  }

  /** Saves only over `expectedHash` when one is given; throws
   * `EMPLOYEE_CONFLICT` when the file moved since it was read. */
  save(id: unknown, path: unknown, text: unknown, expectedHash: unknown): string {
    if (typeof text !== "string") throw new Error("Invalid employee file text");
    if (Buffer.byteLength(text) > FILE_MAX) throw new Error(`${String(path)} is too large`);
    const file = resolveFile(this.dir(id), path);
    if (typeof expectedHash === "string") {
      if (contentHash(readOptional(file) ?? "") !== expectedHash)
        throw new Error(EMPLOYEE_CONFLICT);
    }
    writeAtomic(file, text);
    return contentHash(text);
  }

  /** Copies a desktop's files in, keeping whatever the host already has. */
  import(id: unknown, files: unknown): { written: number } {
    if (!files || typeof files !== "object" || Array.isArray(files))
      throw new Error("Invalid employee files");
    const dir = this.dir(id);
    let written = 0;
    for (const [path, text] of Object.entries(files)) {
      const file = resolveFile(dir, path);
      if (typeof text !== "string" || existsSync(file)) continue;
      if (Buffer.byteLength(text) > FILE_MAX) continue;
      writeAtomic(file, text);
      written++;
    }
    return { written };
  }

  roster(): EmployeeRoster {
    const text = readOptional(join(this.root, ROSTER_FILE));
    if (!text) return { revision: 0, roster: [] };
    try {
      const value = JSON.parse(text) as Partial<EmployeeRoster>;
      return {
        revision: typeof value.revision === "number" ? value.revision : 0,
        roster: Array.isArray(value.roster) ? value.roster : [],
      };
    } catch {
      return { revision: 0, roster: [] };
    }
  }

  /** Replaces the roster when `expectedRevision` is still the current one. */
  saveRoster(roster: unknown, expectedRevision: unknown): EmployeeRoster {
    if (!Array.isArray(roster)) throw new Error("Invalid employee roster");
    for (const entry of roster) {
      const id = (entry as { id?: unknown } | null)?.id;
      if (typeof id !== "string" || !ID.test(id)) throw new Error("Invalid employee roster");
    }
    const text = JSON.stringify(roster);
    if (Buffer.byteLength(text) > ROSTER_MAX) throw new Error("Employee roster is too large");
    const current = this.roster();
    if (expectedRevision !== current.revision) throw new Error(EMPLOYEE_CONFLICT);
    const next = { revision: current.revision + 1, roster };
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writeAtomic(join(this.root, ROSTER_FILE), JSON.stringify(next));
    return next;
  }
}
