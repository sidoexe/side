import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readClaudeUsage, type UsageReading } from "./account-usage";

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
/** An account whose 5h window is this full is used only when all others are. */
const FIVE_HOUR_GUARD = 90;
/** A refresh asked for sooner than this after the last reading reuses it. */
const REFRESH_MIN_MS = 20_000;
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
    private readonly readUsage: (account: HostAccount) => Promise<UsageReading> = readClaudeUsage,
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
   * Reads every Claude account's usage from Anthropic, instead of waiting for
   * the next turn to report it. A reading below both limits frees an account
   * marked limited; one that fails keeps the last levels and says why.
   */
  async refreshUsage(): Promise<void> {
    const usage = this.usage();
    const due = this.config().accounts.filter(
      (account) =>
        account.provider === "claude" &&
        !(usage[account.id]?.updatedAt && this.now() - usage[account.id].updatedAt! < REFRESH_MIN_MS),
    );
    const readings = await Promise.all(due.map((account) => this.readUsage(account)));
    due.forEach((account, index) => {
      const reading = readings[index];
      this.writeUsage(account.id, (current) => {
        if (!reading.ok) return { ...current, error: reading.error };
        const { error: _error, blockedUntil, ...rest } = current;
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
   * The balanced pick. The weekly window decides and the 5h window only guards:
   * ranking on the worse of the two ranks on the 5h in practice, which resets
   * every five hours, so a weekly gap between accounts is never repaid.
   * `free` is false when every account is limited; `account` is then the one
   * that frees up first.
   */
  pick(provider: string, exclude: readonly string[] = []): { account: HostAccount; free: boolean } | undefined {
    const pool = this.pool(provider);
    if (!pool.length) return undefined;
    const usage = this.usage();
    const now = this.now();
    const live = (window?: AccountWindow) =>
      window && (!window.resetsAt || window.resetsAt > now) ? window.used : 0;
    const ranked = pool.map((account) => {
      const entry = usage[account.id] ?? {};
      return {
        account,
        week: live(entry.sevenDay),
        five: live(entry.fiveHour),
        blockedUntil: entry.blockedUntil && entry.blockedUntil > now ? entry.blockedUntil : 0,
        excluded: exclude.includes(account.id),
      };
    });
    const open = ranked.filter((entry) => !entry.blockedUntil && !entry.excluded);
    const order = (a: (typeof ranked)[number], b: (typeof ranked)[number]) =>
      a.week - b.week || a.five - b.five;
    const cool = open.filter((entry) => entry.five < FIVE_HOUR_GUARD).sort(order);
    const hot = open.filter((entry) => entry.five >= FIVE_HOUR_GUARD).sort(order);
    const best = cool[0] ?? hot[0];
    if (best) return { account: best.account, free: true };
    const soonest = [...ranked].sort((a, b) => (a.blockedUntil || Infinity) - (b.blockedUntil || Infinity))[0];
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
