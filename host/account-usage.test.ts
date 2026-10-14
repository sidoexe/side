import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keychainService, readClaudeUsage, type UsageDeps } from "./account-usage";
import { HostAccounts } from "./accounts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "monocode-usage-"));
  dirs.push(dir);
  return dir;
}

const NOW = Date.parse("2026-10-14T10:00:00Z");
const blob = (accessToken: string, expiresAt = NOW + 3_600_000) =>
  JSON.stringify({ claudeAiOauth: { accessToken, expiresAt } });
const body = {
  five_hour: { utilization: 6.0, resets_at: "2026-10-14T11:20:00.411825+00:00" },
  seven_day: { utilization: 73.0, resets_at: "2026-10-17T02:00:00.411849+00:00" },
};

function deps(over: Partial<UsageDeps> = {}) {
  const tokens: string[] = [];
  const value: UsageDeps = {
    platform: "linux",
    keychain: async () => undefined,
    readFile: async () => blob("from-file"),
    fetch: (async (_url: string, init: RequestInit) => {
      tokens.push((init.headers as Record<string, string>).Authorization);
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch,
    now: () => NOW,
    ...over,
  };
  return { value, tokens };
}

describe("reading a Claude account's usage", () => {
  it("names the Keychain entry the way Claude Code does", () => {
    expect(keychainService("/Users/sido/.claude-2")).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    expect(keychainService("/a")).not.toBe(keychainService("/b"));
  });

  it("reads both windows with the profile's token", async () => {
    const { value, tokens } = deps();
    await expect(readClaudeUsage({ configDir: "/p" }, value)).resolves.toEqual({
      ok: true,
      fiveHour: { used: 6, resetsAt: Date.parse("2026-10-14T11:20:00.411Z") },
      sevenDay: { used: 73, resetsAt: Date.parse("2026-10-17T02:00:00.411Z") },
    });
    expect(tokens).toEqual(["Bearer from-file"]);
  });

  it("prefers the Keychain on macOS, where the file can be a stale copy", async () => {
    const { value, tokens } = deps({ platform: "darwin", keychain: async () => blob("from-keychain") });
    await readClaudeUsage({ configDir: "/p" }, value);
    expect(tokens).toEqual(["Bearer from-keychain"]);
  });

  it("never sends an expired token, and reports a refused one", async () => {
    const expired = deps({ readFile: async () => blob("old", NOW - 1) });
    await expect(readClaudeUsage({ configDir: "/p" }, expired.value)).resolves.toMatchObject({ ok: false });
    expect(expired.tokens).toEqual([]);
    const refused = deps({ fetch: (async () => new Response("", { status: 401 })) as typeof fetch });
    await expect(readClaudeUsage({ configDir: "/p" }, refused.value)).resolves.toEqual({
      ok: false,
      error: "Sign-in expired; reconnect this account",
    });
    const none = deps({ readFile: async () => undefined });
    await expect(readClaudeUsage({ configDir: "/p" }, none.value)).resolves.toEqual({
      ok: false,
      error: "Not signed in",
    });
  });
});

describe("refreshing host account usage", () => {
  function setup(read: (id: string) => Parameters<typeof JSON.stringify>[0]) {
    const data = temp();
    writeFileSync(
      join(data, "config.json"),
      JSON.stringify({
        accounts: [
          { id: "one", provider: "claude", label: "One", configDir: "/one" },
          { id: "two", provider: "claude", label: "Two", configDir: "/two" },
          { id: "work", provider: "codex", label: "Work", configDir: "/work" },
        ],
      }),
    );
    let now = NOW;
    const asked: string[] = [];
    const accounts = new HostAccounts(data, () => now, async (account) => {
      asked.push(account.id);
      return read(account.id);
    });
    return { accounts, asked, later: (ms: number) => (now += ms) };
  }

  it("records fresh levels, frees an account below its limits, and keeps the last levels on a failure", async () => {
    const { accounts, asked } = setup((id) =>
      id === "one"
        ? { ok: true, fiveHour: { used: 6 }, sevenDay: { used: 73 } }
        : { ok: false, error: "Sign-in expired; reconnect this account" },
    );
    accounts.recordUsage("two", { fiveHour: { used: 40 } });
    accounts.markBlocked("one", NOW + 3_600_000);
    await accounts.refreshUsage();
    expect(asked).toEqual(["one"]); // two was read moments ago; codex is not Claude
    expect(accounts.usage().one).toEqual({ fiveHour: { used: 6 }, sevenDay: { used: 73 }, updatedAt: NOW });
  });

  it("says why an account could not be read, until it can", async () => {
    let ok = false;
    const { accounts, later } = setup(() =>
      ok ? { ok: true, fiveHour: { used: 10 } } : { ok: false, error: "Not signed in" },
    );
    await accounts.refreshUsage();
    expect(accounts.usage().one.error).toBe("Not signed in");
    ok = true;
    later(60_000);
    await accounts.refreshUsage();
    expect(accounts.usage().one.error).toBeUndefined();
    expect(accounts.usage().one.fiveHour).toEqual({ used: 10 });
  });

  it("keeps an account limited while a window is still full", async () => {
    const { accounts } = setup(() => ({ ok: true, fiveHour: { used: 100 } }));
    accounts.markBlocked("one", NOW + 3_600_000);
    await accounts.refreshUsage();
    expect(accounts.usage().one.blockedUntil).toBe(NOW + 3_600_000);
  });
});
