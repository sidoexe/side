import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { HostCheckpoints } from "./checkpoints";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function repo() {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "side-review-")));
  dirs.push(home);
  const root = join(home, "repo");
  mkdirSync(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "T");
  git("config", "user.email", "t@example.com");
  git("config", "commit.gpgsign", "false");
  const write = (file: string, text: string) => writeFileSync(join(root, file), text);
  write("keep.txt", "keep\n");
  write("edit.txt", "one\ntwo\n");
  write("gone.txt", "bye\n");
  write(".gitignore", "secret.txt\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return { home, root, git, write, review: new HostCheckpoints(join(home, "checkpoints")) };
}

it("reviews only what the turn changed, and undoes it file by file", async () => {
  const { root, git, write, review } = repo();
  write("before.txt", "already dirty before the turn\n");
  await review.begin("s1", root);
  write("edit.txt", "one\nTWO\nthree\n");
  write("new.txt", "fresh\n");
  rmSync(join(root, "gone.txt"));
  write("secret.txt", "ignored\n");
  await review.finish("s1");

  const status = await review.status("s1");
  expect(status.files.map((f) => [f.relative, f.status, f.undoable])).toEqual([
    ["edit.txt", "modified", true],
    ["gone.txt", "deleted", true],
    ["new.txt", "added", true],
  ]);
  expect(status.files[0]).toMatchObject({ additions: 2, deletions: 1, path: join(root, "edit.txt") });

  const diff = await review.fileDiff("s1", "edit.txt");
  expect(diff).toMatchObject({ original: "one\ntwo\n", current: "one\nTWO\nthree\n", binary: false });

  expect((await review.status("s1", [join(root, "new.txt")])).files.map((f) => f.relative)).toEqual(["new.txt"]);

  write("new.txt", "changed by someone else\n");
  expect((await review.status("s1")).files.find((f) => f.relative === "new.txt")?.undoable).toBe(false);
  await expect(review.undo("s1", "new.txt")).rejects.toThrow("changed after the turn");

  const afterUndo = await review.undo("s1", "edit.txt");
  expect(readFileSync(join(root, "edit.txt"), "utf8")).toBe("one\ntwo\n");
  expect(afterUndo.files.map((f) => f.relative)).toEqual(["gone.txt", "new.txt"]);

  await review.keep("s1", "new.txt");
  const rest = await review.undo("s1");
  expect(rest.files).toEqual([]);
  expect(readFileSync(join(root, "gone.txt"), "utf8")).toBe("bye\n");
  expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("changed by someone else\n");
  expect(readFileSync(join(root, "before.txt"), "utf8")).toContain("already dirty");
  expect(git("status", "--porcelain")).not.toContain("edit.txt");
  expect(git("for-each-ref", "refs/side-checkpoints")).toContain("s1/before");

  await review.forget("s1");
  expect(git("for-each-ref", "refs/side-checkpoints")).toBe("");
  expect((await review.status("s1")).files).toEqual([]);
});

it("leaves the real index alone and ignores folders outside Git", async () => {
  const { home, root, git, write, review } = repo();
  write("edit.txt", "staged\n");
  git("add", "edit.txt");
  const index = readFileSync(join(root, ".git/index"));
  await review.begin("s2", root);
  write("keep.txt", "turn edit\n");
  await review.finish("s2");
  expect(readFileSync(join(root, ".git/index")).equals(index)).toBe(true);
  expect((await review.status("s2")).files.map((f) => f.relative)).toEqual(["keep.txt"]);

  const plain = join(home, "plain");
  mkdirSync(plain);
  await review.begin("s3", plain);
  await review.finish("s3");
  expect((await review.status("s3")).files).toEqual([]);
  expect(existsSync(join(home, "checkpoints", "s3.json"))).toBe(false);
});
