import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
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

  close(): void {
    for (const id of [...this.logins.keys()]) this.cancel({ loginId: id });
  }

  private end(id: string) {
    const login = this.logins.get(id);
    if (login) clearTimeout(login.timer);
    this.logins.delete(id);
  }

  /** The next free `perso-N`, in `~/.claude-N` like the hand-made ones. */
  private newAccount(): HostAccount {
    const taken = new Set(this.accounts.config().accounts.map((account) => account.id));
    const pending = new Set([...this.logins.values()].map((login) => login.account.id));
    for (let n = 1; ; n++) {
      const id = `perso-${n}`;
      const configDir = join(this.home, `.claude-${n}`);
      if (taken.has(id) || pending.has(id) || existsSync(configDir)) continue;
      return { id, provider: "claude", label: id, configDir };
    }
  }

  private discard(account: HostAccount) {
    if (this.accounts.config().accounts.some((entry) => entry.id === account.id)) return;
    rmSync(account.configDir, { recursive: true, force: true });
  }

  /** The signed-in address's name, which is how accounts are told apart. */
  private async email(account: HostAccount): Promise<string | undefined> {
    try {
      const env = accountEnv(account);
      const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env.set };
      for (const name of env.unset) delete childEnv[name];
      const child = this.spawn(await this.binary(), ["auth", "status", "--json"], { env: childEnv });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
      await new Promise((resolve) => child.once("exit", resolve));
      const email: unknown = JSON.parse(out).email;
      return typeof email === "string" && email.includes("@")
        ? email.slice(0, email.indexOf("@")).slice(0, 80)
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
