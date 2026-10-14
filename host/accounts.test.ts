import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { HostAccounts, accountEnv, carryClaudeTranscript, parseAccountConfig } from "./accounts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "monocode-accounts-"));
  dirs.push(dir);
  return dir;
}

const config = {
  accounts: [
    { id: "one", provider: "claude", label: "Perso 1", configDir: "~/.claude-1" },
    { id: "two", provider: "claude", configDir: "/tmp/claude-2" },
    { id: "work", provider: "codex", configDir: "/tmp/codex-work" },
    { id: "default", provider: "claude", configDir: "/x" },
    { id: "../bad", provider: "claude", configDir: "/x" },
    { id: "nodir", provider: "claude" },
  ],
  balance: ["one", "two", "ghost"],
  binaries: { claude: "~/bin/claude" },
};

describe("host accounts", () => {
  it("parses only valid accounts and expands home paths", () => {
    const parsed = parseAccountConfig(config);
    expect(parsed.accounts.map((account) => account.id)).toEqual(["one", "two", "work"]);
    expect(parsed.accounts[0]).toEqual({
      id: "one",
      provider: "claude",
      label: "Perso 1",
      configDir: join(homedir(), ".claude-1"),
    });
    expect(parsed.accounts[1].label).toBe("two");
    expect(parsed.balance).toEqual(["one", "two"]);
    expect(parsed.binaries.claude).toBe(join(homedir(), "bin/claude"));
  });

  it("ranks on the weekly window, guards on the 5h one, skips limited accounts", () => {
    const dir = temp();
    let now = 1_000_000;
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      accounts: [
        { id: "a", provider: "claude", configDir: "/a" },
        { id: "b", provider: "claude", configDir: "/b" },
        { id: "c", provider: "claude", configDir: "/c" },
      ],
      balance: ["a", "b", "c"],
    }));
    const accounts = new HostAccounts(dir, () => now);
    const future = now + 3_600_000;
    accounts.recordUsage("a", { sevenDay: { used: 60, resetsAt: future }, fiveHour: { used: 5, resetsAt: future } });
    accounts.recordUsage("b", { sevenDay: { used: 10, resetsAt: future }, fiveHour: { used: 95, resetsAt: future } });
    accounts.recordUsage("c", { sevenDay: { used: 30, resetsAt: future }, fiveHour: { used: 70, resetsAt: future } });
    // b has the least weekly use but its 5h window is about to refuse.
    expect(accounts.pick("claude")?.account.id).toBe("c");
    accounts.markBlocked("c", now + 60_000);
    expect(accounts.pick("claude")?.account.id).toBe("a");
    expect(accounts.pick("claude", ["a"])).toEqual({ account: expect.objectContaining({ id: "b" }), free: true });
    accounts.markBlocked("a", now + 120_000);
    accounts.markBlocked("b", now + 30_000);
    // All limited: report the one that frees up first.
    expect(accounts.pick("claude")).toEqual({ account: expect.objectContaining({ id: "b" }), free: false });
    now += 31_000;
    expect(accounts.pick("claude")).toEqual({ account: expect.objectContaining({ id: "b" }), free: true });
    // Expired windows count as empty.
    now = future + 1;
    expect(accounts.pick("claude")?.account.id).toBe("a");
    expect(accounts.pick("codex")).toBeUndefined();
  });

  it("lists a Balanced choice only when two or more accounts are pooled", () => {
    const dir = temp();
    writeFileSync(join(dir, "config.json"), JSON.stringify(config));
    const ids = new HostAccounts(dir).summaries().map((entry) => `${entry.provider}:${entry.id}`);
    expect(ids).toEqual(["claude:auto", "claude:one", "claude:two", "codex:work"]);
    expect(new HostAccounts(dir).summaries()[0].pool).toEqual(["one", "two"]);
    expect(new HostAccounts(temp()).summaries()).toEqual([]);
  });

  it("rejects an account the host does not know", () => {
    const dir = temp();
    writeFileSync(join(dir, "config.json"), JSON.stringify(config));
    const accounts = new HostAccounts(dir);
    expect(accounts.find("claude", "default")).toBeUndefined();
    expect(accounts.find("claude", "two")?.configDir).toBe("/tmp/claude-2");
    expect(() => accounts.find("claude", "work")).toThrow(/Unknown claude account/);
  });

  it("points each CLI at its profile and drops ambient credentials", () => {
    const [claude, , codex] = parseAccountConfig(config).accounts;
    expect(accountEnv(claude)).toEqual({
      set: { CLAUDE_CONFIG_DIR: claude.configDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: claude.configDir },
      unset: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
    });
    expect(accountEnv(codex).set).toEqual({ CODEX_HOME: "/tmp/codex-work" });
    expect(accountEnv(undefined)).toEqual({ set: {}, unset: [] });
  });

  it("carries a Claude transcript to another profile unless they share projects", () => {
    const root = temp();
    const from = join(root, "from");
    const to = join(root, "to");
    mkdirSync(join(from, "projects", "-Users-me-app"), { recursive: true });
    writeFileSync(join(from, "projects", "-Users-me-app", "conv.jsonl"), "{}\n");
    expect(carryClaudeTranscript(from, to, "conv")).toBe(true);
    expect(readFileSync(join(to, "projects", "-Users-me-app", "conv.jsonl"), "utf8")).toBe("{}\n");
    expect(carryClaudeTranscript(from, to, "missing")).toBe(false);

    const shared = join(root, "shared");
    mkdirSync(shared);
    symlinkSync(join(from, "projects"), join(shared, "projects"));
    expect(carryClaudeTranscript(from, shared, "other")).toBe(true);
    expect(existsSync(join(shared, "projects", "-Users-me-app", "other.jsonl"))).toBe(false);
  });
});
