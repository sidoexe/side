import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { rankBalancedAccounts } from "../src/features/providers/model/balancedAccount";
import { readAccountUsage, type UsageReading } from "./account-usage";

/**
 * Named provider accounts on a host. Each is a CLI profile directory
 * (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) the host user already signed in to.
 * They are declared in `<data dir>/config.json`:
 *
 *   { "accounts": [
 *       { "id": "perso-1", "provider": "claude", "label": "Perso 1", "configDir": "~/.claude-1" },
 *       { "id": "perso-2", "provider": "claude", "label": "Perso 2", "configDir": "~/.claude-2" }
 *     ],
 *     "balance": ["perso-1", "perso-2"],
 *     "binaries": { "claude": "/opt/homebrew/bin/claude" } }
 *
 * `balance` lists the accounts the `auto` choice spreads sessions across: it
 * starts each conversation on the one with the most weekly headroom and moves
 * a conversation to the next one when its account hits a usage limit.
 * `binaries` overrides where a provider CLI is found, which PATH alone decides
 * otherwise.
 */
export const DEFAULT_ACCOUNT = "default";
export const AUTO_ACCOUNT = "auto";
export type AccountProvider = "claude" | "codex";

export type HostAccount = {
  id: string;
  provider: AccountProvider;
  label: string;
  configDir: string;
};

export type HostAccountConfig = {
  accounts: HostAccount[];
  balance: string[];
  binaries: Partial<Record<string, string>>;
};

export type AccountWindow = { used: number; resetsAt?: number };
export type AccountUsage = {
  fiveHour?: AccountWindow;
  sevenDay?: AccountWindow;
  blockedUntil?: number;
  updatedAt?: number;
  /** Why the last refresh could not read this account's usage. */
  error?: string;
  /** No reading before this, after one failed. */
  retryAt?: number;
};

/** What the desktop's account picker shows for a host. */
export type HostAccountSummary = {
  id: string;
  provider: AccountProvider;
  label: string;
  usage?: AccountUsage;
  /** For the balanced choice: the accounts it spreads conversations over. */
  pool?: string[];
  /** For a named account: the balanced choice may use it. */
  balanced?: boolean;
};

const ID = /^[A-Za-z0-9_-]{1,80}$/;
const PROVIDERS = new Set<AccountProvider>(["claude", "codex"]);
/** A refresh asked for sooner than this after the last reading reuses it. */
const REFRESH_MIN_MS = 60_000;
/** After a failed reading, or Anthropic limiting reads, wait this long. */
const RETRY_AFTER_MS = 5 * 60_000;
/** When Claude gives no reset time, try a limited account again after this. */
const UNKNOWN_RESET_MS = 60 * 60 * 1000;

function expand(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** `~/…` for a path under the home folder, as the file is written by hand. */
function home(path: string): string {
  const root = homedir();
  return path.startsWith(`${root}/`) ? `~/${path.slice(root.length + 1)}` : path;
}

export function parseAccountConfig(raw: unknown): HostAccountConfig {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const accounts: HostAccount[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(value.accounts) ? value.accounts : []) {
    if (!entry || typeof entry !== "object") continue;
    const { id, provider, label, configDir } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !ID.test(id) || id === DEFAULT_ACCOUNT || id === AUTO_ACCOUNT) continue;
    if (typeof provider !== "string" || !PROVIDERS.has(provider as AccountProvider)) continue;
    if (typeof configDir !== "string" || !configDir.trim()) continue;
    const key = `${provider}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    accounts.push({
      id,
      provider: provider as AccountProvider,
      label: typeof label === "string" && label.trim() ? label.trim().slice(0, 80) : id,
      configDir: expand(configDir.trim()),
    });
  }
  const balance = (Array.isArray(value.balance) ? value.balance : []).filter(
    (id): id is string => typeof id === "string" && accounts.some((account) => account.id === id),
  );
  const binaries: Partial<Record<string, string>> = {};
  if (value.binaries && typeof value.binaries === "object" && !Array.isArray(value.binaries))
    for (const [provider, path] of Object.entries(value.binaries as Record<string, unknown>))
      if (typeof path === "string" && path.trim()) binaries[provider] = expand(path.trim());
  return { accounts, balance: [...new Set(balance)], binaries };
}

export class HostAccounts {
  private readonly configPath: string;
  private readonly usagePath: string;

  constructor(
    dataDir: string,
    private readonly now: () => number = Date.now,
    private readonly readUsage: (account: HostAccount) => Promise<UsageReading> = (account) =>
      readAccountUsage(account),
  ) {
    this.configPath = join(dataDir, "config.json");
    this.usagePath = join(dataDir, "account-usage.json");
  }

  /** Read on every use, so editing the file needs no host restart. */
  config(): HostAccountConfig {
    try {
      return parseAccountConfig(JSON.parse(readFileSync(this.configPath, "utf8")));
    } catch {
      return { accounts: [], balance: [], binaries: {} };
    }
  }

  /** Declares a newly signed-in profile, and pools it for balancing. */
  addAccount(account: HostAccount): void {
    this.edit((raw) => {
      const accounts = Array.isArray(raw.accounts) ? raw.accounts : [];
      const balance = Array.isArray(raw.balance) ? raw.balance : [];
      return {
        ...raw,
        accounts: [...accounts, { ...account, configDir: home(account.configDir) }],
        balance: balance.includes(account.id) ? balance : [...balance, account.id],
      };
    });
  }

  /** Puts an account in the balanced pool or takes it out. */
  setBalanced(id: string, balanced: boolean): void {
    if (!this.config().accounts.some((account) => account.id === id))
      throw new Error(`Unknown account "${id}" on this host`);
    this.edit((raw) => {
      const balance = (Array.isArray(raw.balance) ? raw.balance : []).filter((entry) => entry !== id);
      return { ...raw, balance: balanced ? [...balance, id] : balance };
    });
  }

  /** Gives an account a new name, as the desktop's Settings does for its own. */
  renameAccount(id: string, label: string): void {
    const next = label.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!next) throw new Error("An account needs a name");
    if (!this.config().accounts.some((account) => account.id === id))
      throw new Error(`Unknown account "${id}" on this host`);
    this.edit((raw) => ({
      ...raw,
      accounts: (Array.isArray(raw.accounts) ? raw.accounts : []).map((entry: unknown) =>
        entry && typeof entry === "object" && (entry as { id?: unknown }).id === id
          ? { ...(entry as object), label: next }
          : entry,
      ),
    }));
  }

  /**
   * Forgets an account: out of the file and the balanced pool, its readings
   * dropped. Its profile folder stays on disk, so a Claude one is offered for
   * import again.
   */
  removeAccount(id: string): void {
    if (!this.config().accounts.some((account) => account.id === id))
      throw new Error(`Unknown account "${id}" on this host`);
    this.edit((raw) => ({
      ...raw,
      accounts: (Array.isArray(raw.accounts) ? raw.accounts : []).filter(
        (entry: unknown) => !(entry && typeof entry === "object" && (entry as { id?: unknown }).id === id),
      ),
      balance: (Array.isArray(raw.balance) ? raw.balance : []).filter((entry) => entry !== id),
    }));
    const all = this.usage();
    if (!(id in all)) return;
    delete all[id];
    this.saveUsage(all);
  }

  /** Rewrites the config file, keeping everything else as written. */
  private edit(change: (raw: Record<string, unknown>) => Record<string, unknown>): void {
    let raw: Record<string, unknown> = {};
    try {
      const value: unknown = JSON.parse(readFileSync(this.configPath, "utf8"));
      if (value && typeof value === "object" && !Array.isArray(value)) raw = value as Record<string, unknown>;
    } catch {
      /* a host without accounts yet */
    }
    const tmp = `${this.configPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(change(raw), null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.configPath);
  }

  binary(provider: string): string | undefined {
    return this.config().binaries[provider];
  }

  find(provider: string, id: string | undefined): HostAccount | undefined {
    if (!id || id === DEFAULT_ACCOUNT) return undefined;
    const account = this.config().accounts.find((entry) => entry.provider === provider && entry.id === id);
    if (!account) throw new Error(`Unknown ${provider} account "${id}" on this host`);
    return account;
  }

  /** Accounts the `auto` choice can use for a provider. */
  pool(provider: string): HostAccount[] {
    const config = this.config();
    return config.balance
      .map((id) => config.accounts.find((account) => account.id === id && account.provider === provider))
      .filter((account): account is HostAccount => !!account);
  }

  summaries(): HostAccountSummary[] {
    const usage = this.usage();
    const config = this.config();
    const list: HostAccountSummary[] = config.accounts.map((account) => ({
      id: account.id,
      provider: account.provider,
      label: account.label,
      usage: usage[account.id],
      balanced: config.balance.includes(account.id),
    }));
    for (const provider of PROVIDERS)
      if (this.pool(provider).length > 1)
        list.unshift({
          id: AUTO_ACCOUNT,
          provider,
          label: "Balanced",
          pool: this.pool(provider).map((account) => account.id),
        });
    return list;
  }

  usage(): Record<string, AccountUsage> {
    try {
      const value: unknown = JSON.parse(readFileSync(this.usagePath, "utf8"));
      return value && typeof value === "object" ? (value as Record<string, AccountUsage>) : {};
    } catch {
      return {};
    }
  }

  private writeUsage(id: string, update: (current: AccountUsage) => AccountUsage): void {
    const all = this.usage();
    all[id] = update(all[id] ?? {});
    this.saveUsage(all);
  }

  private saveUsage(all: Record<string, AccountUsage>): void {
    const tmp = `${this.usagePath}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(all)}\n`, { mode: 0o600 });
      renameSync(tmp, this.usagePath);
    } catch (error) {
      console.debug("[monocode] account usage", error);
    }
  }

  recordUsage(id: string, windows: { fiveHour?: AccountWindow; sevenDay?: AccountWindow }): void {
    this.writeUsage(id, ({ error: _error, ...current }) => ({
      ...current,
      ...(windows.fiveHour ? { fiveHour: windows.fiveHour } : {}),
      ...(windows.sevenDay ? { sevenDay: windows.sevenDay } : {}),
      updatedAt: this.now(),
    }));
  }

  /**
   * Reads every account's usage, Claude's from Anthropic and Codex's from its
   * CLI, instead of waiting for the next turn to report it. A reading below both limits frees an account
   * marked limited; one that fails keeps the last levels and says why.
   */
  async refreshUsage(): Promise<void> {
    const usage = this.usage();
    const due = this.config().accounts.filter((account) => {
      const entry = usage[account.id];
      if (entry?.retryAt && entry.retryAt > this.now()) return false;
      return !(entry?.updatedAt && this.now() - entry.updatedAt < REFRESH_MIN_MS);
    });
    const readings = await Promise.all(due.map((account) => this.readUsage(account)));
    due.forEach((account, index) => {
      const reading = readings[index];
      this.writeUsage(account.id, (current) => {
        // A refused read keeps the last levels and says nothing about the
        // account, so Balanced keeps using it; a real failure says why.
        if (!reading.ok)
          return reading.retry
            ? { ...current, retryAt: this.now() + RETRY_AFTER_MS }
            : { ...current, error: reading.error, retryAt: this.now() + REFRESH_MIN_MS };
        const { error: _error, retryAt: _retryAt, blockedUntil, ...rest } = current;
        const full = [reading.fiveHour, reading.sevenDay].some((window) => window && window.used >= 100);
        return {
          ...rest,
          ...(reading.fiveHour ? { fiveHour: reading.fiveHour } : {}),
          ...(reading.sevenDay ? { sevenDay: reading.sevenDay } : {}),
          ...(full && blockedUntil ? { blockedUntil } : {}),
          updatedAt: this.now(),
        };
      });
    });
  }

  markBlocked(id: string, resetsAt?: number): void {
    const until = resetsAt && resetsAt > this.now() ? resetsAt : this.now() + UNKNOWN_RESET_MS;
    this.writeUsage(id, (current) => ({ ...current, blockedUntil: until }));
  }

  /**
   * The balanced pick, by the rule the desktop follows too: the weekly window
   * decides and the 5h window only guards, an account whose sign-in failed is
   * never taken and one never read comes last.
   * `free` is false when no account is usable; `account` is then the one
   * that frees up first, one that can still sign in if any.
   */
  pick(provider: string, exclude: readonly string[] = []): { account: HostAccount; free: boolean } | undefined {
    const pool = this.pool(provider);
    if (!pool.length) return undefined;
    const usage = this.usage();
    const now = this.now();
    const live = (window?: AccountWindow) =>
      window && (!window.resetsAt || window.resetsAt > now) ? window.used : undefined;
    const candidates = pool.map((account) => {
      const entry = usage[account.id] ?? {};
      return {
        account,
        id: account.id,
        fiveHour: live(entry.fiveHour),
        weekly: live(entry.sevenDay),
        read: !!entry.updatedAt,
        error: !!entry.error,
        blockedUntil: entry.blockedUntil,
      };
    });
    const best = rankBalancedAccounts(candidates, { now, exclude })[0];
    if (best) return { account: pool.find((account) => account.id === best)!, free: true };
    const until = (entry: (typeof candidates)[number]) =>
      entry.blockedUntil && entry.blockedUntil > now ? entry.blockedUntil : Number.MAX_SAFE_INTEGER;
    const soonest = [...candidates].sort(
      (a, b) => Number(a.error) - Number(b.error) || until(a) - until(b),
    )[0];
    return { account: soonest.account, free: false };
  }
}

/** Environment that points a provider CLI at an account's profile. The same
 * variables the desktop sets for its local accounts. */
export function accountEnv(account: HostAccount | undefined): {
  set: Record<string, string>;
  unset: string[];
} {
  if (!account) return { set: {}, unset: [] };
  if (account.provider === "claude")
    return {
      set: { CLAUDE_CONFIG_DIR: account.configDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: account.configDir },
      unset: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
    };
  return {
    set: { CODEX_HOME: account.configDir },
    unset: ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"],
  };
}

/** The profile directory Claude reads for an account, `default` included. */
export function claudeConfigDir(account: HostAccount | undefined): string {
  return account?.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

/**
 * Makes a Claude conversation resumable from another account: Claude keeps
 * each transcript under its profile's `projects/<encoded cwd>/<id>.jsonl`.
 * Profiles that share one `projects` directory need nothing.
 */
export function carryClaudeTranscript(fromDir: string, toDir: string, providerSessionId: string): boolean {
  const from = join(fromDir, "projects");
  const to = join(toDir, "projects");
  if (!existsSync(from)) return false;
  try {
    if (existsSync(to) && realpathSync(from) === realpathSync(to)) return true;
  } catch {
    /* fall through to a copy */
  }
  const file = `${providerSessionId}.jsonl`;
  for (const folder of readdirSync(from)) {
    const source = join(from, folder, file);
    if (!existsSync(source)) continue;
    mkdirSync(join(to, folder), { recursive: true });
    copyFileSync(source, join(to, folder, file));
    // Subagent transcripts and large tool results sit beside it.
    const sidecar = join(from, folder, providerSessionId);
    if (existsSync(sidecar))
      cpSync(sidecar, join(to, folder, providerSessionId), { recursive: true });
    return true;
  }
  return false;
}
