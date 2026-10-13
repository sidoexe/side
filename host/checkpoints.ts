import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  CheckpointFile,
  CheckpointFileDiff,
  CheckpointStatus,
} from "../src/features/sessions/model/checkpoint";

const exec = promisify(execFile);
const MAX_DIFF_BYTES = 1024 * 1024;
const MAX_FILES = 500;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

type Turn = {
  root: string;
  before: string;
  after?: string;
  /** Files the user kept or restored; they leave the review. */
  settled: string[];
};

type Change = {
  relative: string;
  status: string;
  additions: number;
  deletions: number;
  before?: { mode: string; oid: string };
  after?: { mode: string; oid: string };
};

/** The host's turn review: the checkout as Git trees before and after each
 * turn, kept under a private ref so `git gc` leaves them alone. Undo writes the
 * "before" content back only where the file still matches the turn's result. */
export class HostCheckpoints {
  private queues = new Map<string, Promise<unknown>>();

  constructor(private readonly directory: string) {}

  begin(sessionId: string, cwd: string): Promise<void> {
    return this.serial(sessionId, async () => {
      const root = await gitRoot(cwd).catch(() => undefined);
      if (!root) return this.forgetNow(sessionId);
      const before = await snapshot(root, sessionId, "before");
      await this.write(sessionId, { root, before, settled: [] });
    });
  }

  finish(sessionId: string): Promise<void> {
    return this.serial(sessionId, async () => {
      const turn = await this.read(sessionId);
      if (!turn) return;
      turn.after = await snapshot(turn.root, sessionId, "after");
      await this.write(sessionId, turn);
    });
  }

  status(sessionId: string, editedPaths?: readonly string[]): Promise<CheckpointStatus> {
    return this.serial(sessionId, () => this.statusNow(sessionId, editedPaths));
  }

  fileDiff(sessionId: string, file: string): Promise<CheckpointFileDiff> {
    return this.serial(sessionId, async () => {
      const turn = await this.read(sessionId);
      if (!turn?.after) throw new Error("This turn has no recorded changes");
      const relativePath = safeRelative(turn.root, file);
      const change = (await changes(turn)).find((entry) => entry.relative === relativePath);
      if (!change) throw new Error("This file did not change in the turn");
      const [original, current] = await Promise.all([
        change.before ? blob(turn.root, change.before.oid) : Buffer.alloc(0),
        change.after ? blob(turn.root, change.after.oid) : Buffer.alloc(0),
      ]);
      const binary = original.includes(0) || current.includes(0);
      const tooLarge = original.length > MAX_DIFF_BYTES || current.length > MAX_DIFF_BYTES;
      return {
        path: join(turn.root, relativePath),
        relative: relativePath,
        status: change.status,
        original: binary || tooLarge ? "" : original.toString("utf8"),
        current: binary || tooLarge ? "" : current.toString("utf8"),
        binary,
        tooLarge,
      };
    });
  }

  undo(sessionId: string, file?: string | null): Promise<CheckpointStatus> {
    return this.serial(sessionId, async () => {
      const turn = await this.read(sessionId);
      if (!turn?.after) return { files: [] };
      const wanted = file ? safeRelative(turn.root, file) : undefined;
      for (const change of await changes(turn)) {
        if (turn.settled.includes(change.relative)) continue;
        if (wanted && change.relative !== wanted) continue;
        if (!(await matches(turn.root, change.relative, change.after))) {
          if (wanted) throw new Error("This file changed after the turn; restore it by hand.");
          continue;
        }
        const target = join(turn.root, change.relative);
        if (change.before) {
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, await blob(turn.root, change.before.oid));
          await chmod(target, change.before.mode === "100755" ? 0o755 : 0o644);
        } else {
          await rm(target, { force: true });
        }
        turn.settled.push(change.relative);
      }
      await this.write(sessionId, turn);
      return this.statusNow(sessionId);
    });
  }

  keep(sessionId: string, file?: string | null): Promise<CheckpointStatus> {
    return this.serial(sessionId, async () => {
      const turn = await this.read(sessionId);
      if (!turn?.after) return { files: [] };
      const wanted = file ? safeRelative(turn.root, file) : undefined;
      for (const change of await changes(turn))
        if (!wanted || change.relative === wanted)
          if (!turn.settled.includes(change.relative)) turn.settled.push(change.relative);
      await this.write(sessionId, turn);
      return this.statusNow(sessionId);
    });
  }

  forget(sessionId: string): Promise<void> {
    return this.serial(sessionId, () => this.forgetNow(sessionId));
  }

  private async statusNow(
    sessionId: string,
    editedPaths?: readonly string[],
  ): Promise<CheckpointStatus> {
    const turn = await this.read(sessionId);
    if (!turn?.after) return { files: [] };
    const edited = editedPaths?.length
      ? new Set(editedPaths.map((path) => safeRelative(turn.root, path)))
      : undefined;
    const files: CheckpointFile[] = [];
    for (const change of await changes(turn)) {
      if (turn.settled.includes(change.relative)) continue;
      if (edited && !edited.has(change.relative)) continue;
      // Already back to how it was: nothing left to review.
      if (await matches(turn.root, change.relative, change.before)) continue;
      files.push({
        path: join(turn.root, change.relative),
        relative: change.relative,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        exact: true,
        undoable: await matches(turn.root, change.relative, change.after),
      });
      if (files.length >= MAX_FILES) break;
    }
    return { files };
  }

  private async forgetNow(sessionId: string): Promise<void> {
    const turn = await this.read(sessionId);
    await rm(this.file(sessionId), { force: true });
    if (turn)
      for (const label of ["before", "after"])
        await git(turn.root, ["update-ref", "-d", checkpointRef(sessionId, label)]).catch(
          () => undefined,
        );
  }

  private file(sessionId: string): string {
    if (!ID.test(sessionId)) throw new Error("Invalid session ID");
    return join(this.directory, `${sessionId}.json`);
  }

  private async read(sessionId: string): Promise<Turn | undefined> {
    try {
      return JSON.parse(await readFile(this.file(sessionId), "utf8")) as Turn;
    } catch {
      return undefined;
    }
  }

  private async write(sessionId: string, turn: Turn): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(this.file(sessionId), JSON.stringify(turn), { mode: 0o600 });
  }

  private serial<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.catch(() => undefined);
    this.queues.set(sessionId, tail);
    void tail.then(() => {
      if (this.queues.get(sessionId) === tail) this.queues.delete(sessionId);
    });
    return result;
  }
}

function checkpointRef(sessionId: string, label: string): string {
  return `refs/side-checkpoints/${sessionId}/${label}`;
}

async function git(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

async function gitRoot(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
}

/** The whole checkout as a tree, untracked files included, ignored ones not,
 * without touching the real index. */
async function snapshot(root: string, sessionId: string, label: string): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "side-checkpoint-"));
  const env = {
    GIT_INDEX_FILE: join(scratch, "index"),
    GIT_AUTHOR_NAME: "sIDE",
    GIT_AUTHOR_EMAIL: "checkpoints@side.local",
    GIT_COMMITTER_NAME: "sIDE",
    GIT_COMMITTER_EMAIL: "checkpoints@side.local",
  };
  try {
    const head = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "");
    if (head.trim()) await git(root, ["read-tree", "HEAD"], env);
    await git(root, ["add", "-A", "--", "."], env);
    const tree = (await git(root, ["write-tree"], env)).trim();
    const commit = (
      await git(root, ["commit-tree", tree, "-m", "sIDE workspace checkpoint"], env)
    ).trim();
    await git(root, ["update-ref", checkpointRef(sessionId, label), commit]);
    return tree;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function changes(turn: Turn): Promise<Change[]> {
  if (!turn.after) return [];
  const [raw, numstat] = await Promise.all([
    git(turn.root, ["diff-tree", "-r", "-z", "--no-renames", turn.before, turn.after]),
    git(turn.root, ["diff-tree", "-r", "-z", "--no-renames", "--numstat", turn.before, turn.after]),
  ]);
  const stats = new Map<string, { additions: number; deletions: number }>();
  const numParts = numstat.split("\0").filter(Boolean);
  for (const part of numParts) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(part);
    if (match)
      stats.set(match[3], {
        additions: match[1] === "-" ? 0 : Number(match[1]),
        deletions: match[2] === "-" ? 0 : Number(match[2]),
      });
  }
  const parts = raw.split("\0").filter(Boolean);
  const out: Change[] = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const [meta, path] = [parts[index], parts[index + 1]];
    const [oldMode, newMode, oldOid, newOid, letter] = meta.replace(/^:/, "").split(" ");
    const zero = /^0+$/;
    out.push({
      relative: path,
      status: letter === "A" ? "added" : letter === "D" ? "deleted" : "modified",
      ...(stats.get(path) ?? { additions: 0, deletions: 0 }),
      ...(zero.test(oldOid) ? {} : { before: { mode: oldMode, oid: oldOid } }),
      ...(zero.test(newOid) ? {} : { after: { mode: newMode, oid: newOid } }),
    });
  }
  return out;
}

async function blob(root: string, oid: string): Promise<Buffer> {
  const { stdout } = await exec("git", ["cat-file", "blob", oid], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/** Whether the file on disk is exactly `entry` (absent when `entry` is). */
async function matches(
  root: string,
  relativePath: string,
  entry: { oid: string } | undefined,
): Promise<boolean> {
  const content = await readFile(join(root, relativePath)).catch(() => undefined);
  if (!entry) return content === undefined;
  if (content === undefined) return false;
  const oid = (await git(root, ["hash-object", "--", relativePath])).trim();
  return oid === entry.oid;
}

function safeRelative(root: string, path: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const rel = relative(root, absolute).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Path is outside this checkout");
  return rel;
}
