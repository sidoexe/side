import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Employees' conversations on the home machine, so every desktop opens the
 * same chat. Mirrors `src-tauri/src/mono_transcript.rs`: blocks in order, an
 * index of where each turn starts so a page never scans old blocks, and
 * saves that replace only the suffix the writer changed.
 *
 * One difference: two desktops can write the same chat. A save names the
 * last block its writer saved before; when the host's chat no longer ends
 * there, someone else wrote in between, and replacing the suffix would erase
 * their blocks. That save is merged instead: blocks the host already has are
 * updated where they stand, new ones are appended, and nothing is removed.
 */

const PAGE_TURNS = 10;
const ID = /^[A-Za-z0-9._:-]{1,200}$/;

type Block = Record<string, unknown> & { id: string; role?: string };

export type EmployeeSessionSummary = {
  sidebarHidden: boolean;
  id: string;
  cwd: string;
  harness: string;
  model: string;
  runtimeMode: string;
  title: string;
  providerSessionId?: string;
  branch?: string;
  worktreeCwd?: string;
  worktreeRemoved: boolean;
  additions: number;
  deletions: number;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  pinned: boolean;
  draft: boolean;
  linkedWorkItem?: unknown;
  automationId?: string;
};

export type EmployeePage = { blocks: unknown[]; before: number | null; hasNewer: boolean };

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function searchText(block: Block): string {
  if (!["user", "assistant", "tool", "tasks", "plan", "image"].includes(String(block.role)))
    return "";
  const tool = (block.tool ?? {}) as Record<string, any>;
  const image = (block.image ?? {}) as Record<string, any>;
  const preview = (tool.preview ?? {}) as Record<string, any>;
  return [
    block.text,
    tool.title,
    image.name,
    image.alt,
    tool.detail,
    preview.query,
    preview.path,
    preview.output,
    preview.title,
  ]
    .filter((part): part is string => typeof part === "string")
    .join("\n")
    .toLowerCase();
}

function validId(value: unknown, what: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`Invalid ${what} ID`);
  return value;
}

function blocksOf(value: unknown): Block[] {
  if (!Array.isArray(value)) throw new Error("blocks must be an array");
  return value.map((block) => {
    if (!block || typeof block !== "object" || typeof (block as Block).id !== "string" || !(block as Block).id)
      throw new Error("Block needs an id");
    return block as Block;
  });
}

export class HostEmployeeTranscripts {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, header TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        has_user INTEGER NOT NULL DEFAULT 0, is_draft INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS turns (session_id TEXT NOT NULL, seq INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq));
      CREATE TABLE IF NOT EXISTS blocks (session_id TEXT NOT NULL, seq INTEGER NOT NULL,
        block_id TEXT NOT NULL, block_json TEXT NOT NULL, search_text TEXT NOT NULL,
        is_user INTEGER NOT NULL, is_draft INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq), UNIQUE (session_id, block_id));
      CREATE INDEX IF NOT EXISTS blocks_user ON blocks(session_id, is_user, is_draft);`);
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private seqOf(id: string, blockId: string): number {
    const row = this.db
      .prepare("SELECT seq FROM blocks WHERE session_id = ? AND block_id = ?")
      .get(id, blockId);
    if (!row) throw new Error("Transcript anchor is missing");
    return Number(row.seq);
  }

  private lastBlockId(id: string): string | null {
    const row = this.db
      .prepare("SELECT block_id FROM blocks WHERE session_id = ? ORDER BY seq DESC LIMIT 1")
      .get(id);
    return row ? String(row.block_id) : null;
  }

  private insert(id: string, after: number, blocks: Block[]): void {
    const insertBlock = this.db.prepare(
      "INSERT INTO blocks(session_id, seq, block_id, block_json, search_text, is_user, is_draft) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const insertTurn = this.db.prepare("INSERT INTO turns(session_id, seq) VALUES (?, ?)");
    // A handoff occupies its own turn, including when a suffix is edited.
    const previous = this.db
      .prepare("SELECT block_json FROM blocks WHERE session_id = ? AND seq = ?")
      .get(id, after);
    let afterHandoff = previous ? JSON.parse(String(previous.block_json)).role === "handoff" : false;
    blocks.forEach((block, index) => {
      const seq = after + index + 1;
      const user = block.role === "user";
      if (
        seq === 1 ||
        afterHandoff ||
        (block.internal !== true && (block.role === "user" || block.role === "handoff")) ||
        block.monoHabit !== undefined
      )
        insertTurn.run(id, seq);
      afterHandoff = block.role === "handoff";
      insertBlock.run(id, seq, block.id, JSON.stringify(block), searchText(block),
        user ? 1 : 0, user && block.draft === true ? 1 : 0);
    });
  }

  /** Blocks another desktop never saw: update the ones the host has where
   * they stand, append the rest, and remove nothing. */
  private merge(id: string, blocks: Block[]): void {
    const update = this.db.prepare(
      "UPDATE blocks SET block_json = ?, search_text = ?, is_draft = ? WHERE session_id = ? AND block_id = ?",
    );
    const fresh: Block[] = [];
    for (const block of blocks) {
      const changed = update.run(JSON.stringify(block), searchText(block),
        block.role === "user" && block.draft === true ? 1 : 0, id, block.id);
      if (!Number(changed.changes)) fresh.push(block);
    }
    const max = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM blocks WHERE session_id = ?")
      .get(id);
    this.insert(id, Number(max?.seq ?? 0), fresh);
  }

  private summary(id: string): EmployeeSessionSummary {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    if (!row) throw new Error("Unknown employee session");
    const header = JSON.parse(String(row.header)) as Record<string, unknown>;
    return {
      sidebarHidden: header.sidebarHidden === true,
      id,
      cwd: String(header.cwd ?? ""),
      harness: String(header.harness ?? ""),
      model: String(header.model ?? ""),
      runtimeMode: String(header.runtimeMode ?? ""),
      title: String(header.title ?? ""),
      ...(text(header.providerSessionId) ? { providerSessionId: text(header.providerSessionId) } : {}),
      ...(text(header.branch) && header.worktreeRemoved !== true ? { branch: text(header.branch) } : {}),
      ...(text(header.worktreeCwd) ? { worktreeCwd: text(header.worktreeCwd) } : {}),
      worktreeRemoved: header.worktreeRemoved === true,
      additions: 0,
      deletions: 0,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      archived: false,
      pinned: false,
      draft: Number(row.is_draft) === 1,
      ...(header.linkedWorkItem != null ? { linkedWorkItem: header.linkedWorkItem } : {}),
      ...(text(header.automationId) ? { automationId: text(header.automationId) } : {}),
    };
  }

  /**
   * Saves the header and, when `blocksChanged`, replaces the blocks after the
   * anchor: `afterBlockId`, the block before `fromBlockId`, the end for
   * `appendOnly`, or the start. `baseLastBlockId` is the last block the
   * writer saved before; a chat that moved on since is merged into instead.
   */
  upsert(input: Record<string, unknown>): EmployeeSessionSummary {
    const session = input.session as Record<string, unknown> | undefined;
    if (!session || typeof session !== "object") throw new Error("Invalid employee session");
    const id = validId(session.id, "session");
    for (const key of ["providerSessionId", "providerAccountId", "automationId"])
      if (text(session[key])) validId(session[key], "provider");
    if (!text(session.cwd) || !session.modelSettings || typeof session.modelSettings !== "object")
      throw new Error("Invalid employee session");
    const blocks = blocksOf(session.blocks ?? []);
    const { blocks: _, ...header } = session;
    return this.transaction(() => {
      const now = Date.now();
      this.db
        .prepare(`INSERT INTO sessions(id, header, created_at, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET header = excluded.header`)
        .run(id, JSON.stringify(header), now, now);
      if (input.blocksChanged === true) {
        const known = this.lastBlockId(id);
        const base = "baseLastBlockId" in input ? (input.baseLastBlockId ?? null) : known;
        if (base !== known && known !== null) {
          this.merge(id, blocks);
        } else {
          const anchor =
            input.appendOnly === true
              ? Number(this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM blocks WHERE session_id = ?").get(id)?.seq ?? 0)
              : typeof input.afterBlockId === "string"
                ? this.seqOf(id, input.afterBlockId)
                : typeof input.fromBlockId === "string"
                  ? this.seqOf(id, input.fromBlockId) - 1
                  : 0;
          this.db.prepare("DELETE FROM turns WHERE session_id = ? AND seq > ?").run(id, anchor);
          this.db.prepare("DELETE FROM blocks WHERE session_id = ? AND seq > ?").run(id, anchor);
          this.insert(id, anchor, blocks);
        }
        this.db
          .prepare("UPDATE sessions SET updated_at = MAX(updated_at + 1, ?) WHERE id = ?")
          .run(now, id);
      }
      const flags = this.db
        .prepare(`SELECT EXISTS(SELECT 1 FROM blocks WHERE session_id = ? AND is_user = 1) AS user,
          EXISTS(SELECT 1 FROM blocks WHERE session_id = ? AND is_user = 1 AND is_draft = 1) AS draft`)
        .get(id, id);
      this.db
        .prepare("UPDATE sessions SET has_user = ?, is_draft = ? WHERE id = ?")
        .run(Number(flags?.user ?? 0), Number(flags?.draft ?? 0), id);
      return this.summary(id);
    });
  }

  page(sessionIdInput: unknown, options: Record<string, unknown> = {}): EmployeePage {
    const id = validId(sessionIdInput, "session");
    let end = Number.MAX_SAFE_INTEGER;
    if (typeof options.aroundBlockId === "string") {
      const seq = this.seqOf(id, options.aroundBlockId);
      const next = this.db
        .prepare("SELECT seq FROM turns WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT 1")
        .get(id, seq);
      end = next ? Number(next.seq) : Number.MAX_SAFE_INTEGER;
    } else if (typeof options.beforeBlockId === "string") {
      end = this.seqOf(id, options.beforeBlockId);
    } else if (typeof options.before === "number") {
      end = options.before;
    }
    const starts = this.db
      .prepare("SELECT seq FROM turns WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?")
      .all(id, end, PAGE_TURNS + 1)
      .map((row) => Number(row.seq));
    const start = starts.slice(0, PAGE_TURNS).at(-1) ?? end;
    const blocks = this.db
      .prepare("SELECT block_json FROM blocks WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq")
      .all(id, start, end)
      .map((row) => JSON.parse(String(row.block_json)) as unknown);
    const newer = this.db
      .prepare("SELECT EXISTS(SELECT 1 FROM blocks WHERE session_id = ? AND seq >= ?) AS newer")
      .get(id, end);
    return {
      blocks,
      before: starts.length > PAGE_TURNS ? start : null,
      hasNewer: Number(newer?.newer ?? 0) === 1,
    };
  }

  /** The session as the desktop's `mono_session_get` returns it, with its
   * newest page; `null` when the host has never seen it. */
  get(sessionIdInput: unknown): Record<string, unknown> | null {
    const id = validId(sessionIdInput, "session");
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    if (!row) return null;
    const header = JSON.parse(String(row.header)) as Record<string, unknown>;
    const page = this.page(id);
    const first = page.blocks[0] as { id?: unknown } | undefined;
    return {
      ...header,
      id,
      blocks: page.blocks,
      queuedMessages: Array.isArray(header.queuedMessages) ? header.queuedMessages : [],
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      monoTranscript: {
        before: page.before,
        firstBlockId: typeof first?.id === "string" ? first.id : null,
      },
    };
  }

  find(sessionIdInput: unknown, query: unknown): string[] {
    const id = validId(sessionIdInput, "session");
    const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
    if (!needle) return [];
    return this.db
      .prepare("SELECT block_id FROM blocks WHERE session_id = ? AND instr(search_text, ?) > 0 ORDER BY seq LIMIT 1000")
      .all(id, needle)
      .map((row) => String(row.block_id));
  }

  delete(sessionIdInput: unknown): void {
    const id = validId(sessionIdInput, "session");
    this.transaction(() => {
      for (const table of ["blocks", "turns"])
        this.db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(id);
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    });
  }
}
