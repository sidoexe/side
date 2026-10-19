import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { HostEmployeeTranscripts } from "./employee-transcripts";

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
 * ├── backgrounds.json  when each one's background image last changed
 * ├── inbox.json        messages sent from the browser, until a desktop runs them
 * ├── accounts.json     the accounts a desktop can move employees to
 * ├── transcripts.db    their conversations (see employee-transcripts.ts)
 * └── <employee id>/
 *     ├── SOUL.md
 *     ├── MEMORY.md
 *     ├── habits.json
 *     ├── background.*  its chat's background image, if it has one
 *     └── memory/       topic notes, and archive.md
 * ```
 */

const SOUL_FILE = "SOUL.md";
const MEMORY_FILE = "MEMORY.md";
const HABITS_FILE = "habits.json";
const MEMORY_DIR = "memory";
const ROSTER_FILE = "roster.json";
const BACKGROUNDS_FILE = "backgrounds.json";
const INBOX_FILE = "inbox.json";
const ACCOUNTS_FILE = "accounts.json";
const ACCOUNTS_MAX = 64 * 1024;
const INBOX_TEXT_MAX = 64 * 1024;
const INBOX_MAX = 100;
/** How long a desktop that took a message has to hand it over before
 * another one may. */
const INBOX_LEASE_MS = 60_000;
const BACKGROUND_STEM = "background";
const BACKGROUND_MAX = 8 * 1024 * 1024;
const BACKGROUND_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const FILE_MAX = 256 * 1024;
const ROSTER_MAX = 512 * 1024;
const ID = /^[A-Za-z0-9-]{1,80}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/;
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

/** When an employee's background last changed, and its image's type; no
 * type once it was removed, so the removal reaches every desktop too. */
export type EmployeeBackgroundStamp = { updatedAt: number; mimeType?: string };

/** A message the browser app sent an employee. Chats run on a desktop, so
 * it waits here until one takes it and sends it as if typed there. */
export type EmployeeInboxMessage = {
  id: string;
  mono: string;
  text: string;
  /** Asks the desktop to move the employee to this account instead. */
  account?: string;
  /** The conversation it goes to, or `new` to start one; the open one when absent. */
  thread?: string;
  /** `stop` interrupts the turn; `steer` sends the text into it at once. */
  control?: "stop" | "steer";
  at: number;
  takenBy?: string;
  takenAt?: number;
};

/** The provider accounts the desktop running the employees offers, and the
 * one each employee is on, so the browser app can ask for a move. */
export type EmployeeAccounts = {
  accounts: { provider: string; id: string; label: string }[];
  current: Record<string, { provider: string; account: string }>;
  /** Each employee's state on that desktop: working, waiting on the user, idle. */
  status?: Record<string, { status: string; activity?: string }>;
  /** The same for each of their conversations that is open there, by its id. */
  threads?: Record<string, { status: string; activity?: string }>;
  /** The sessions each employee started that run, wait or recently ended. */
  work?: Record<string, EmployeeWorkItem[]>;
  at: number;
};

export type EmployeeWorkItem = {
  sessionId: string;
  title: string;
  cwd: string;
  harness: string;
  state: string;
  activity?: string;
  at: number;
  settledAt?: number;
  /** Settled and not yet checked on the desktop. */
  toReview?: true;
};

const WORK_STATES = new Set(["working", "input", "done", "failed", "stopped"]);
/** Per employee, as the desktop sends them. */
const WORK_MAX = 12;

/** Keeps the well-formed entries, so one bad field never drops the rest. */
function sanitizeWork(value: unknown): Record<string, EmployeeWorkItem[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const text = (entry: unknown, max: number) =>
    typeof entry === "string" ? entry.slice(0, max) : undefined;
  const time = (entry: unknown) =>
    typeof entry === "number" && Number.isFinite(entry) ? entry : undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([mono, items]) => {
      if (!Array.isArray(items)) return [];
      const kept = items.slice(0, WORK_MAX).flatMap((raw): EmployeeWorkItem[] => {
        const item = (raw ?? {}) as Record<string, unknown>;
        const sessionId = text(item.sessionId, 512);
        const cwd = text(item.cwd, 4096);
        const harness = text(item.harness, 64);
        const at = time(item.at);
        if (!sessionId || !cwd || !harness || at === undefined) return [];
        if (typeof item.state !== "string" || !WORK_STATES.has(item.state)) return [];
        const activity = text(item.activity, 200);
        const settledAt = time(item.settledAt);
        return [
          {
            sessionId,
            title: text(item.title, 200) ?? "",
            cwd,
            harness,
            state: item.state,
            ...(activity ? { activity } : {}),
            at,
            ...(settledAt !== undefined ? { settledAt } : {}),
            ...(item.toReview === true ? { toReview: true as const } : {}),
          },
        ];
      });
      return kept.length ? [[mono, kept]] : [];
    }),
  );
}

export type EmployeeBackground = { updatedAt: number; mimeType: string; data: string };

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
  private chats?: HostEmployeeTranscripts;

  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}

  get transcripts(): HostEmployeeTranscripts {
    this.chats ??= new HostEmployeeTranscripts(join(this.root, "transcripts.db"));
    return this.chats;
  }

  close(): void {
    this.chats?.close();
    this.chats = undefined;
  }

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
    if (Buffer.byteLength(text) > ROSTER_MAX) throw new Error("Colleague roster is too large");
    const current = this.roster();
    if (expectedRevision !== current.revision) throw new Error(EMPLOYEE_CONFLICT);
    const next = { revision: current.revision + 1, roster };
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writeAtomic(join(this.root, ROSTER_FILE), JSON.stringify(next));
    // An employee taken off the roster takes its background along.
    const kept = new Set(roster.map((entry) => (entry as { id: string }).id));
    const stamps = this.backgrounds();
    const gone = current.roster
      .map((entry) => (entry as { id?: unknown } | null)?.id)
      .filter((id): id is string => typeof id === "string" && ID.test(id) && !kept.has(id) && !!stamps[id]);
    if (gone.length) {
      for (const id of gone) {
        this.removeBackgroundFiles(join(this.root, id));
        delete stamps[id];
      }
      this.saveBackgrounds(stamps);
    }
    return next;
  }

  /** Every employee's background stamp, by id. */
  backgrounds(): Record<string, EmployeeBackgroundStamp> {
    const text = readOptional(join(this.root, BACKGROUNDS_FILE));
    if (!text) return {};
    try {
      const value = JSON.parse(text) as Record<string, EmployeeBackgroundStamp>;
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }

  private saveBackgrounds(stamps: Record<string, EmployeeBackgroundStamp>): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writeAtomic(join(this.root, BACKGROUNDS_FILE), JSON.stringify(stamps));
  }

  private removeBackgroundFiles(dir: string): void {
    for (const extension of Object.values(BACKGROUND_TYPES))
      rmSync(join(dir, `${BACKGROUND_STEM}.${extension}`), { force: true });
  }

  /** The image's file and type, for the browser app. */
  backgroundFile(id: unknown): { path: string; type: string } | undefined {
    if (typeof id !== "string" || !ID.test(id)) return undefined;
    const type = this.backgrounds()[id]?.mimeType;
    const extension = type ? BACKGROUND_TYPES[type] : undefined;
    if (!type || !extension) return undefined;
    const path = join(this.root, id, `${BACKGROUND_STEM}.${extension}`);
    return existsSync(path) ? { path, type } : undefined;
  }

  /** The image itself, as the desktops store it. */
  background(id: unknown): EmployeeBackground | null {
    const stamp = this.backgrounds()[id as string];
    const dir = this.dir(id);
    const extension = stamp?.mimeType ? BACKGROUND_TYPES[stamp.mimeType] : undefined;
    if (!stamp || !extension) return null;
    const path = join(dir, `${BACKGROUND_STEM}.${extension}`);
    if (!existsSync(path)) return null;
    return {
      updatedAt: stamp.updatedAt,
      mimeType: stamp.mimeType!,
      data: readFileSync(path).toString("base64"),
    };
  }

  /**
   * Sets an employee's background, or removes it when there is no `data`,
   * unless the host already has a newer change: the newest one wins, and
   * the stamp kept is returned either way.
   */
  setBackground(id: unknown, input: Record<string, unknown>): EmployeeBackgroundStamp {
    const dir = this.dir(id);
    const updatedAt = Number(input.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) throw new Error("Invalid background time");
    const stamps = this.backgrounds();
    const current = stamps[id as string];
    if (current && current.updatedAt > updatedAt) return current;
    let next: EmployeeBackgroundStamp = { updatedAt };
    let bytes: Buffer | undefined;
    if (input.data !== undefined && input.data !== null) {
      const extension = BACKGROUND_TYPES[String(input.mimeType)];
      if (!extension || typeof input.data !== "string")
        throw new Error("Choose a PNG, JPEG, WebP or GIF image");
      bytes = Buffer.from(input.data, "base64");
      if (!bytes.length || bytes.length > BACKGROUND_MAX)
        throw new Error("Background images are limited to 8 MB");
      next = { updatedAt, mimeType: String(input.mimeType) };
    }
    this.removeBackgroundFiles(dir);
    if (bytes) {
      const path = join(dir, `${BACKGROUND_STEM}.${BACKGROUND_TYPES[next.mimeType!]}`);
      const temp = `${path}.tmp`;
      writeFileSync(temp, bytes, { mode: 0o600 });
      renameSync(temp, path);
    }
    stamps[id as string] = next;
    this.saveBackgrounds(stamps);
    return next;
  }
  private readInbox(): EmployeeInboxMessage[] {
    try {
      const value: unknown = JSON.parse(readOptional(join(this.root, INBOX_FILE)) ?? "[]");
      return Array.isArray(value) ? (value as EmployeeInboxMessage[]) : [];
    } catch {
      return [];
    }
  }

  private saveInbox(messages: EmployeeInboxMessage[]): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writeAtomic(join(this.root, INBOX_FILE), JSON.stringify(messages));
  }

  private free(message: EmployeeInboxMessage): boolean {
    return !message.takenAt || this.now() - message.takenAt >= INBOX_LEASE_MS;
  }

  /** Queues a message from the browser app for an employee on the roster,
   * or with `account`, a request to move it to that account. */
  post(
    id: unknown,
    text: unknown,
    account?: unknown,
    thread?: unknown,
    control?: unknown,
  ): EmployeeInboxMessage {
    if (control !== undefined && control !== "stop" && control !== "steer")
      throw new Error("Invalid control");
    if (typeof id !== "string" || !ID.test(id)) throw new Error("Invalid employee ID");
    if (thread !== undefined && (typeof thread !== "string" || !THREAD_ID.test(thread)))
      throw new Error("Invalid conversation");
    if (account !== undefined && (typeof account !== "string" || !ACCOUNT_ID.test(account)))
      throw new Error("Invalid account");
    const body = typeof text === "string" ? text : "";
    if (account === undefined && control !== "stop" && !body.trim())
      throw new Error("Write a message first");
    if (Buffer.byteLength(body) > INBOX_TEXT_MAX) throw new Error("The message is too long");
    if (!this.roster().roster.some((entry) => (entry as { id?: unknown } | null)?.id === id))
      throw new Error("Unknown colleague");
    const messages = this.readInbox();
    if (messages.length >= INBOX_MAX) throw new Error("Too many messages are waiting for a desktop");
    const message: EmployeeInboxMessage = {
      id: randomUUID(),
      mono: id,
      text: body,
      ...(account === undefined ? {} : { account: account as string }),
      ...(thread === undefined ? {} : { thread: thread as string }),
      ...(control === undefined ? {} : { control: control as "stop" | "steer" }),
      at: this.now(),
    };
    this.saveInbox([...messages, message]);
    return message;
  }

  /** Messages still waiting, for one employee or all of them. */
  inbox(id?: unknown): EmployeeInboxMessage[] {
    const messages = this.readInbox();
    return typeof id === "string" ? messages.filter((message) => message.mono === id) : messages;
  }

  /** Messages no desktop is holding, oldest first. */
  waiting(): EmployeeInboxMessage[] {
    return this.readInbox().filter((message) => this.free(message));
  }

  /** Gives the message to `by` unless another desktop holds it. */
  take(messageId: unknown, by: unknown): boolean {
    if (typeof by !== "string" || !by) throw new Error("Invalid desktop");
    const messages = this.readInbox();
    const message = messages.find((entry) => entry.id === messageId);
    if (!message || (!this.free(message) && message.takenBy !== by)) return false;
    message.takenBy = by;
    message.takenAt = this.now();
    this.saveInbox(messages);
    return true;
  }

  /** What the desktop last published, or null before it has. */
  accounts(): EmployeeAccounts | null {
    try {
      const value: unknown = JSON.parse(readOptional(join(this.root, ACCOUNTS_FILE)) ?? "null");
      return value && typeof value === "object" ? (value as EmployeeAccounts) : null;
    } catch {
      return null;
    }
  }

  /** The desktop running the employees says where they can move. */
  setAccounts(value: unknown): void {
    const record = value as Partial<EmployeeAccounts> | null;
    const accounts = Array.isArray(record?.accounts)
      ? record.accounts.filter(
          (entry) =>
            !!entry &&
            typeof entry.provider === "string" &&
            typeof entry.id === "string" &&
            ACCOUNT_ID.test(entry.id) &&
            typeof entry.label === "string",
        )
      : undefined;
    const current = record?.current && typeof record.current === "object" ? record.current : undefined;
    if (!accounts || !current) throw new Error("Invalid accounts");
    const status = record?.status && typeof record.status === "object" ? record.status : {};
    const threads = record?.threads && typeof record.threads === "object" ? record.threads : {};
    const work = sanitizeWork(record?.work);
    const text = JSON.stringify({ accounts, current, status, threads, work, at: this.now() });
    if (Buffer.byteLength(text) > ACCOUNTS_MAX) throw new Error("Too many accounts");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writeAtomic(join(this.root, ACCOUNTS_FILE), text);
  }

  /** The desktop sent it: it leaves the inbox. */
  delivered(messageId: unknown): void {
    const messages = this.readInbox();
    const kept = messages.filter((entry) => entry.id !== messageId);
    if (kept.length !== messages.length) this.saveInbox(kept);
  }
}
