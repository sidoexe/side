import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hostCommitMessage } from "./commit-message";
import type { HostProvider } from "./providers";
import { HostStore } from "./store";
import { WorkspaceCommands } from "./workspace-commands";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const context = { branch: "main", summary: "M a.txt", patch: "+hello" };
const fake = (reply: string): HostProvider =>
  ({ runText: vi.fn(async () => reply) }) as unknown as HostProvider;

it("asks the preferred installed provider and formats its answer", async () => {
  const claude = fake('{"subject":"Add hello","body":"Says hello."}');
  const codex = fake('{"subject":"Wrong one"}');
  const message = await hostCommitMessage({
    cwd: "/repo",
    context,
    installed: ["codex", "claude"],
    providers: { claude, codex },
    preferred: "codex",
  });
  expect(message).toBe("Wrong one");
  expect(
    await hostCommitMessage({ cwd: "/repo", context, installed: ["codex", "claude"], providers: { claude, codex } }),
  ).toBe("Add hello\n\nSays hello.");
  expect(vi.mocked(claude.runText!).mock.calls[0][0].prompt).toContain("+hello");
});

it("says so when no provider can answer or the reply is unusable", async () => {
  await expect(
    hostCommitMessage({ cwd: "/repo", context, installed: ["fx"], providers: {} }),
  ).rejects.toThrow("No provider");
  await expect(
    hostCommitMessage({ cwd: "/repo", context, installed: ["claude"], providers: { claude: fake("nope") } }),
  ).rejects.toThrow("Model replied: nope");
});

it("writes the message from the host's staged diff", async () => {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "side-commit-")));
  dirs.push(home);
  const cwd = join(home, "repo");
  mkdirSync(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "T");
  git("config", "user.email", "t@example.com");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(cwd, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(cwd, "a.txt"), "two\n");
  git("add", "a.txt");
  const store = new HostStore(join(home, "host.db"));
  store.addProject(cwd, "repo");
  const writer = vi.fn(async () => "Change a");
  const commands = new WorkspaceCommands(store, async (_id, action) => action(), writer);
  try {
    expect(await commands.run("generate_commit_message", { cwd, harness: "claude" })).toBe("Change a");
    expect(writer).toHaveBeenCalledWith(cwd, expect.objectContaining({ branch: "main" }), "claude");
    expect((writer.mock.calls[0] as unknown[])[1]).toMatchObject({ patch: expect.stringContaining("+two") });
    git("reset", "-q");
    await expect(commands.run("generate_commit_message", { cwd })).rejects.toThrow("Stage some changes");
  } finally {
    store.close();
  }
});

it("writes with Pi, omp or Devin on a host that has only those", async () => {
  for (const id of ["pi", "omp", "devin"] as const) {
    const provider = fake('{"subject":"From ' + id + '"}');
    expect(await hostCommitMessage({ cwd: "/repo", context, installed: [id], providers: { [id]: provider } })).toBe(`From ${id}`);
  }
});

it("every provider the desktop names branches with does so on a host too", async () => {
  const { hostProviders } = await import("./providers");
  for (const id of ["codex", "claude", "cursor", "grok", "opencode"] as const)
    expect(hostProviders[id].generateBranchName, id).toBeTypeOf("function");
  for (const id of ["codex", "claude", "cursor", "grok", "opencode", "pi", "omp", "devin"] as const)
    expect(hostProviders[id].runText, id).toBeTypeOf("function");
});
