import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { accountEnv, type HostAccount, type HostAccounts } from "./accounts";

/**
 * Signs a host account in from a desktop that may be another computer.
 * `claude auth login` prints a sign-in link and reads the code the browser
 * shows from stdin, so the desktop opens the link where the user sits and
 * sends the code back. The host's own browser is never opened.
 */
const URL_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const LINK = /visit:\s*(https:\/\/\S+)/;
const STATUS_TIMEOUT_MS = 15_000;
/** Profiles made by hand or by an older tool: `~/.claude-1`, `~/.claude-work`. */
const PROFILE = /^\.claude-[A-Za-z0-9._-]+$/;

type Spawn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;

type Login = {
  child: ChildProcessWithoutNullStreams;
  account: HostAccount;
  /** A profile made for this sign-in, declared once it succeeds. */
  created: boolean;
  output: string;
  exit: Promise<number | null>;
  timer: ReturnType<typeof setTimeout>;
};

export type AccountLoginStart = { loginId: string; url: string; accountId: string };
export type AccountLoginDone = { accountId: string; label: string };
/** A signed-in profile on the host that no account declares yet. */
export type FoundAccount = { configDir: string; label: string };

export class HostAccountLogins {
  private logins = new Map<string, Login>();

  constructor(
    private readonly accounts: HostAccounts,
    private readonly binary: () => Promise<string>,
    private readonly spawn: Spawn = (command, args, options) =>
      nodeSpawn(command, args, { ...options, stdio: "pipe" }),
    private readonly home: string = homedir(),
  ) {}

  /** Starts a sign-in: an existing account's again, or a new one's. */
  async start(params: { accountId?: unknown }): Promise<AccountLoginStart> {
    const existing =
      typeof params.accountId === "string" && params.accountId
        ? this.accounts.find("claude", params.accountId)
        : undefined;
    if (typeof params.accountId === "string" && params.accountId && !existing)
      throw new Error("Choose a Claude account of this host");
    const account = existing ?? this.newAccount();
    const binary = await this.binary();
    const env = accountEnv(account);
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env.set, BROWSER: "/usr/bin/true" };
    for (const name of env.unset) delete childEnv[name];
    const child = this.spawn(binary, ["auth", "login"], { env: childEnv });
    const exit = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
      child.once("error", () => resolve(null));
    });
    const loginId = randomUUID();
    const login: Login = {
      child,
      account,
      created: !existing,
      output: "",
      exit,
      timer: setTimeout(() => this.cancel({ loginId }), LOGIN_TIMEOUT_MS),
    };
    this.logins.set(loginId, login);
    const url = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => fail("Claude did not offer a sign-in link"), URL_TIMEOUT_MS);
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.cancel({ loginId });
        reject(new Error(message));
      };
      const read = (chunk: Buffer) => {
        login.output += chunk.toString();
        const match = LINK.exec(login.output);
        if (match && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(match[1]);
        }
      };
      child.stdout.on("data", read);
      child.stderr.on("data", read);
      void exit.then(() => fail(lastLine(login.output) || "Claude sign-in stopped"));
    });
    return { loginId, url, accountId: account.id };
  }

  /** Hands Claude the code the browser showed, and waits for the result. */
  async finish(params: { loginId?: unknown; code?: unknown }): Promise<AccountLoginDone> {
    const login = this.logins.get(String(params.loginId ?? ""));
    if (!login) throw new Error("This sign-in has ended; start it again");
    const code = typeof params.code === "string" ? params.code.trim() : "";
    if (!code || /\s/.test(code)) throw new Error("Paste the code shown after signing in");
    const before = login.output.length;
    login.child.stdin.write(`${code}\n`);
    const status = await login.exit;
    this.end(String(params.loginId));
    if (status !== 0) {
      if (login.created) this.discard(login.account);
      throw new Error(lastLine(login.output.slice(before)) || "Claude sign-in failed");
    }
    if (!login.created) return { accountId: login.account.id, label: login.account.label };
    const account = { ...login.account, label: (await this.email(login.account)) ?? login.account.label };
    this.accounts.addAccount(account);
    return { accountId: account.id, label: account.label };
  }

  cancel(params: { loginId?: unknown }): void {
    const id = String(params.loginId ?? "");
    const login = this.logins.get(id);
    if (!login) return;
    this.end(id);
    login.child.kill();
    if (login.created) void login.exit.then(() => this.discard(login.account));
  }

  /**
   * Claude profiles under the home folder that are signed in but not declared,
   * so an account made outside sIDE can join the pool without signing in
   * again. A profile whose address an account already has is left out: it is
   * a copy of it.
   */
  async found(): Promise<FoundAccount[]> {
    const declared = this.accounts.config().accounts.filter((account) => account.provider === "claude");
    const real = (path: string) => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    };
    const taken = new Set(declared.map((account) => real(account.configDir)));
    let names: string[] = [];
    try {
      names = readdirSync(this.home).filter((name) => PROFILE.test(name)).sort(byNumber);
    } catch {
      return [];
    }
    const candidates = names
      .map((name) => join(this.home, name))
      .filter((dir) => {
        try {
          return statSync(dir).isDirectory() && existsSync(join(dir, ".claude.json")) && !taken.has(real(dir));
        } catch {
          return false;
        }
      });
    if (!candidates.length) return [];
    const [known, statuses] = await Promise.all([
      Promise.all(declared.map((account) => this.status(account.configDir))),
      Promise.all(candidates.map((dir) => this.status(dir))),
    ]);
    const emails = new Set(known.map((status) => status?.email).filter(Boolean));
    const found: FoundAccount[] = [];
    candidates.forEach((dir, index) => {
      const email = statuses[index]?.email;
      if (!email || emails.has(email)) return;
      emails.add(email);
      found.push({ configDir: home(dir, this.home), label: localPart(email) });
    });
    return found;
  }

  /** Declares a found profile as an account, pooled for balancing. */
  async adopt(params: { configDir?: unknown }): Promise<AccountLoginDone> {
    const wanted = typeof params.configDir === "string" ? params.configDir : "";
    const match = (await this.found()).find((entry) => entry.configDir === wanted);
    if (!match) throw new Error("This profile is not signed in, or is already an account");
    const account: HostAccount = {
      id: this.freeId(),
      provider: "claude",
      label: match.label,
      configDir: join(this.home, match.configDir.replace(/^~\//, "")),
    };
    this.accounts.addAccount(account);
    return { accountId: account.id, label: account.label };
  }

  close(): void {
    for (const id of [...this.logins.keys()]) this.cancel({ loginId: id });
  }

  private end(id: string) {
    const login = this.logins.get(id);
    if (login) clearTimeout(login.timer);
    this.logins.delete(id);
  }

  private takenIds(): Set<string> {
    return new Set([
      ...this.accounts.config().accounts.map((account) => account.id),
      ...[...this.logins.values()].map((login) => login.account.id),
    ]);
  }

  /** The next free `perso-N`, in `~/.claude-N` like the hand-made ones. */
  private newAccount(): HostAccount {
    const taken = this.takenIds();
    for (let n = 1; ; n++) {
      const id = `perso-${n}`;
      const configDir = join(this.home, `.claude-${n}`);
      if (taken.has(id) || existsSync(configDir)) continue;
      return { id, provider: "claude", label: id, configDir };
    }
  }

  /** The next free `perso-N`, for a profile that already has its folder. */
  private freeId(): string {
    const taken = this.takenIds();
    for (let n = 1; ; n++) if (!taken.has(`perso-${n}`)) return `perso-${n}`;
  }

  private discard(account: HostAccount) {
    if (this.accounts.config().accounts.some((entry) => entry.id === account.id)) return;
    rmSync(account.configDir, { recursive: true, force: true });
  }

  /** The signed-in address's name, which is how accounts are told apart. */
  private async email(account: HostAccount): Promise<string | undefined> {
    const email = (await this.status(account.configDir))?.email;
    return email ? localPart(email) : undefined;
  }

  /** `claude auth status` for a profile; nothing when it is signed out or
   * does not answer. */
  private async status(configDir: string): Promise<{ email: string } | undefined> {
    try {
      const env = accountEnv({ id: "status", provider: "claude", label: "", configDir });
      const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env.set };
      for (const name of env.unset) delete childEnv[name];
      const child = this.spawn(await this.binary(), ["auth", "status", "--json"], { env: childEnv });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
      const timer = setTimeout(() => child.kill(), STATUS_TIMEOUT_MS);
      await new Promise((resolve) => {
        child.once("exit", resolve);
        child.once("error", resolve);
      });
      clearTimeout(timer);
      const value = JSON.parse(out) as { loggedIn?: unknown; email?: unknown };
      return value.loggedIn !== false && typeof value.email === "string" && value.email.includes("@")
        ? { email: value.email }
        : undefined;
    } catch {
      return undefined;
    }
  }
}

function lastLine(text: string): string {
  const line = text
    .split(/[\r\n]+/)
    .map((entry) => entry.replace(/^.*Paste code here if prompted >\s*/, "").trim())
    .filter(Boolean)
    .pop();
  return line ? line.replace(/https?:\/\/\S+/g, "sign-in link").slice(0, 240) : "";
}

function localPart(email: string): string {
  return email.slice(0, email.indexOf("@")).slice(0, 80);
}

/** `~/…` for a folder under the home folder, as config.json is written. */
function home(path: string, root: string): string {
  return path.startsWith(`${root}/`) ? `~/${path.slice(root.length + 1)}` : path;
}

/** `.claude-2` before `.claude-10`. */
function byNumber(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}
