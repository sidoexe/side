import { execFile, spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCodexRateLimits } from "../src/features/providers/model/rateLimits";
import { accountEnv, type AccountWindow, type HostAccount } from "./accounts";

/**
 * Reads a Claude account's 5h and weekly usage from Anthropic, with the
 * token Claude Code keeps for that profile. Read-only: an expired token is
 * reported, never refreshed, because Claude Code rotates its refresh token
 * and a second refresher would log the running CLI out.
 */
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const USER_AGENT = "claude-code/2.1.0";
const TIMEOUT_MS = 10_000;
const KEYCHAIN_SERVICE = "Claude Code-credentials";

export type UsageReading =
  | { ok: true; fiveHour?: AccountWindow; sevenDay?: AccountWindow }
  | { ok: false; error: string };

type Token = { accessToken: string; expiresAt?: number };

export type UsageDeps = {
  platform: NodeJS.Platform;
  keychain: (service: string) => Promise<string | undefined>;
  readFile: (path: string) => Promise<string | undefined>;
  fetch: typeof fetch;
  now: () => number;
};

const defaults: UsageDeps = {
  platform: process.platform,
  keychain: (service) =>
    new Promise((resolve) =>
      execFile("security", ["find-generic-password", "-s", service, "-w"], { timeout: 5_000 }, (error, out) =>
        resolve(error ? undefined : out),
      ),
    ),
  readFile: (path) => readFile(path, "utf8").catch(() => undefined),
  fetch: (...args) => fetch(...args),
  now: Date.now,
};

/** Claude Code's Keychain entry for a profile: the first eight hex digits of
 * the SHA-256 of its exact folder path. */
export function keychainService(configDir: string): string {
  const digest = createHash("sha256").update(configDir.normalize("NFC")).digest("hex");
  return `${KEYCHAIN_SERVICE}-${digest.slice(0, 8)}`;
}

function token(raw: string | undefined): Token | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw.trim()) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } };
    const oauth = value.claudeAiOauth;
    if (typeof oauth?.accessToken !== "string" || !oauth.accessToken) return undefined;
    return {
      accessToken: oauth.accessToken,
      expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : undefined,
    };
  } catch {
    return undefined;
  }
}

/** macOS keeps the live token in the Keychain; the file may be a stale copy. */
async function readToken(configDir: string, deps: UsageDeps): Promise<Token | undefined> {
  if (deps.platform === "darwin") {
    const fromKeychain = token(await deps.keychain(keychainService(configDir)));
    if (fromKeychain) return fromKeychain;
  }
  return token(await deps.readFile(join(configDir, ".credentials.json")));
}

function window(raw: unknown): AccountWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { utilization, resets_at } = raw as { utilization?: unknown; resets_at?: unknown };
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return undefined;
  const resetsAt = typeof resets_at === "string" ? Date.parse(resets_at) : NaN;
  return {
    used: Math.max(0, Math.min(100, utilization)),
    ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
  };
}

export async function readClaudeUsage(
  account: Pick<HostAccount, "configDir">,
  deps: UsageDeps = defaults,
): Promise<UsageReading> {
  const found = await readToken(account.configDir, deps);
  if (!found) return { ok: false, error: "Not signed in" };
  if (found.expiresAt && found.expiresAt <= deps.now())
    return { ok: false, error: "Sign-in expired; use Claude on this account to renew it" };
  try {
    const response = await deps.fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${found.accessToken}`,
        "anthropic-beta": OAUTH_BETA,
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 401) return { ok: false, error: "Sign-in expired; reconnect this account" };
    if (!response.ok) return { ok: false, error: `Usage unavailable (${response.status})` };
    const body = (await response.json()) as { five_hour?: unknown; seven_day?: unknown };
    return { ok: true, fiveHour: window(body.five_hour), sevenDay: window(body.seven_day) };
  } catch {
    return { ok: false, error: "Usage unavailable" };
  }
}

/** Any account's usage: Claude's from Anthropic, Codex's from its own CLI. */
export function readAccountUsage(
  account: HostAccount,
  codexBinary: () => Promise<string> = async () => "codex",
): Promise<UsageReading> {
  return account.provider === "codex"
    ? codexBinary().then(
        (binary) => readCodexUsage(account, binary),
        () => ({ ok: false as const, error: "Codex CLI not found" }),
      )
    : readClaudeUsage(account);
}

export type CodexSpawn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;

const CODEX_TIMEOUT_MS = 20_000;
const spawnCodex: CodexSpawn = (command, args, options) => nodeSpawn(command, args, { ...options, stdio: "pipe" });

/**
 * Asks a Codex profile's app server one question, the way the desktop reads
 * Codex usage: Codex itself holds the sign-in and renews it, so nothing here
 * touches its tokens.
 */
export function codexRequest(
  binary: string,
  configDir: string,
  method: string,
  spawn: CodexSpawn = spawnCodex,
): Promise<unknown> {
  const env = accountEnv({ id: "usage", provider: "codex", label: "", configDir });
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env.set };
  for (const name of env.unset) delete childEnv[name];
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const child = spawn(binary, ["app-server"], { env: childEnv });
    const done = (error: Error | undefined, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => done(new Error("Codex did not answer")), CODEX_TIMEOUT_MS);
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.on("error", () => undefined);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: { id?: unknown; method?: unknown; result?: unknown; error?: { message?: unknown } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        // Its own requests (approvals and the like) get an empty answer.
        if (typeof message.method === "string") {
          if (message.id !== undefined) send({ id: message.id, result: {} });
        } else if (message.error)
          done(new Error(String(message.error.message ?? "Codex refused the request")));
        else if (message.id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method, params: {} });
        } else if (message.id === 2) done(undefined, message.result);
      }
    });
    child.once("error", (error) => done(error));
    child.once("exit", () => done(new Error("Codex stopped before answering")));
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "monocode", title: "sIDE", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

/** A Codex account's 5h and weekly usage. A monthly plan has neither. */
export async function readCodexUsage(
  account: Pick<HostAccount, "configDir">,
  binary: string,
  spawn?: CodexSpawn,
): Promise<UsageReading> {
  try {
    const limits = parseCodexRateLimits(
      await codexRequest(binary, account.configDir, "account/rateLimits/read", spawn),
    );
    const window = (value: typeof limits.session): AccountWindow | undefined =>
      value ? { used: value.usedPercent, ...(value.resetsAt ? { resetsAt: value.resetsAt } : {}) } : undefined;
    return { ok: true, fiveHour: window(limits.session), sevenDay: window(limits.weekly) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not signed in|authentication required|not authenticated/i.test(message))
      return { ok: false, error: "Not signed in" };
    if (/ENOENT/.test(message)) return { ok: false, error: "Codex CLI not found" };
    return { ok: false, error: message.slice(0, 240) || "Usage unavailable" };
  }
}
