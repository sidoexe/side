import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { HostAccounts } from "./accounts";
import { HostAccountLogins } from "./account-login";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "monocode-login-"));
  dirs.push(dir);
  return dir;
}

type Call = { args: string[]; env: NodeJS.ProcessEnv; child: FakeChild };
type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  written: string;
  kill: () => boolean;
};

/** A stand-in for `claude auth login` / `auth status`, driven by the test. */
function fakeClaude(
  onCode: (code: string, call: Call) => void,
  statusOf: (configDir: string) => unknown = () => ({ loggedIn: true, email: "new.person@example.com" }),
) {
  const calls: Call[] = [];
  const spawn = (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      written: "",
      kill: () => {
        child.emit("exit", null);
        return true;
      },
    }) as FakeChild;
    const call = { args, env: options.env, child };
    calls.push(call);
    if (args[1] === "status") {
      setTimeout(() => {
        child.stdout.write(JSON.stringify(statusOf(options.env.CLAUDE_CONFIG_DIR!)));
        child.emit("exit", 0);
      });
    } else {
      child.stdin.on("data", (chunk: Buffer) => {
        child.written += chunk.toString();
        onCode(child.written.trim(), call);
      });
      setTimeout(() =>
        child.stdout.write(
          "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&x=1\nPaste code here if prompted > ",
        ),
      );
    }
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { calls, spawn };
}

function setup(
  onCode: (code: string, call: Call) => void,
  config?: unknown,
  statusOf?: (configDir: string) => unknown,
) {
  const data = temp();
  const home = temp();
  if (config) writeFileSync(join(data, "config.json"), JSON.stringify(config));
  const accounts = new HostAccounts(data);
  const claude = fakeClaude(onCode, statusOf);
  const logins = new HostAccountLogins(accounts, async () => "/bin/claude", claude.spawn, home);
  return { data, home, accounts, logins, claude };
}

const succeed = (_code: string, call: Call) => {
  mkdirSync(call.env.CLAUDE_CONFIG_DIR!, { recursive: true });
  call.child.emit("exit", 0);
};

describe("host account sign-in", () => {
  it("adds a new account named after its address once Claude accepts the code", async () => {
    const { data, home, logins, accounts, claude } = setup(succeed, {
      accounts: [{ id: "perso-1", provider: "claude", label: "One", configDir: "~/.claude-1" }],
      balance: ["perso-1"],
      binaries: { claude: "/opt/claude" },
    });
    mkdirSync(join(home, ".claude-2"));
    const started = await logins.start({});
    expect(started.url).toBe("https://claude.com/cai/oauth/authorize?code=true&x=1");
    expect(started.accountId).toBe("perso-3");
    expect(claude.calls[0].args).toEqual(["auth", "login"]);
    expect(claude.calls[0].env.CLAUDE_CONFIG_DIR).toBe(join(home, ".claude-3"));
    expect(claude.calls[0].env.BROWSER).toBe("/usr/bin/true");

    await expect(logins.finish({ loginId: started.loginId, code: " abc#state " })).resolves.toEqual({
      accountId: "perso-3",
      label: "new.person",
    });
    expect(claude.calls[0].child.written).toBe("abc#state\n");
    const written = JSON.parse(readFileSync(join(data, "config.json"), "utf8"));
    expect(written.binaries).toEqual({ claude: "/opt/claude" });
    expect(written.balance).toEqual(["perso-1", "perso-3"]);
    expect(accounts.config().accounts.map((account) => account.label)).toEqual(["One", "new.person"]);
  });

  it("signs an existing account in again without declaring it twice", async () => {
    const { data, logins, claude } = setup(succeed, {
      accounts: [{ id: "perso-1", provider: "claude", label: "One", configDir: "/tmp/one" }],
      balance: ["perso-1"],
    });
    const before = readFileSync(join(data, "config.json"), "utf8");
    const started = await logins.start({ accountId: "perso-1" });
    expect(claude.calls[0].env.CLAUDE_CONFIG_DIR).toBe("/tmp/one");
    await expect(logins.finish({ loginId: started.loginId, code: "abc" })).resolves.toEqual({
      accountId: "perso-1",
      label: "One",
    });
    expect(readFileSync(join(data, "config.json"), "utf8")).toBe(before);
  });

  it("reports a refused code and leaves no half-made profile", async () => {
    const { home, logins, accounts } = setup((_code, call) => {
      mkdirSync(call.env.CLAUDE_CONFIG_DIR!, { recursive: true });
      call.child.stdout.write("Login failed: Request failed with status code 400\n");
      call.child.emit("exit", 1);
    });
    const started = await logins.start({});
    await expect(logins.finish({ loginId: started.loginId, code: "bad" })).rejects.toThrow(
      "Login failed: Request failed with status code 400",
    );
    expect(existsSync(join(home, ".claude-1"))).toBe(false);
    expect(accounts.config().accounts).toEqual([]);
    await expect(logins.finish({ loginId: started.loginId, code: "again" })).rejects.toThrow(
      "This sign-in has ended",
    );
  });

  it("refuses an unknown account and a cancelled sign-in", async () => {
    const { logins } = setup(succeed);
    await expect(logins.start({ accountId: "ghost" })).rejects.toThrow('Unknown claude account "ghost"');
    const started = await logins.start({});
    logins.cancel({ loginId: started.loginId });
    await expect(logins.finish({ loginId: started.loginId, code: "abc" })).rejects.toThrow(
      "This sign-in has ended",
    );
  });
});

describe("host account import", () => {
  const emails: Record<string, string> = {
    ".claude-1": "one@example.com",
    ".claude-2": "two@example.com",
    ".claude-copy": "one@example.com",
    ".claude-10": "ten@example.com",
  };
  const statusOf = (dir: string) => {
    const email = emails[dir.slice(dir.lastIndexOf("/") + 1)];
    return email ? { loggedIn: true, email } : { loggedIn: false };
  };

  /** A home with `.claude-1` declared, and profiles made outside sIDE. */
  function withProfiles() {
    const env = setup(succeed, undefined, statusOf);
    const profile = (name: string) => {
      mkdirSync(join(env.home, name));
      writeFileSync(join(env.home, name, ".claude.json"), "{}");
    };
    for (const name of [".claude-1", ".claude-2", ".claude-copy", ".claude-10", ".claude-out"]) profile(name);
    mkdirSync(join(env.home, ".claude-empty"));
    writeFileSync(join(env.home, ".claude-file"), "");
    writeFileSync(
      join(env.data, "config.json"),
      JSON.stringify({
        accounts: [{ id: "perso-1", provider: "claude", label: "one", configDir: join(env.home, ".claude-1") }],
        balance: ["perso-1"],
      }),
    );
    return env;
  }

  it("offers signed-in profiles no account declares, without copies of one", async () => {
    const { logins, claude } = withProfiles();
    await expect(logins.found()).resolves.toEqual([
      { configDir: expect.stringMatching(/\.claude-2$/), label: "two" },
      { configDir: expect.stringMatching(/\.claude-10$/), label: "ten" },
    ]);
    // Folders without a Claude profile are never asked about.
    const asked = claude.calls.map((call) => call.env.CLAUDE_CONFIG_DIR!.split("/").pop());
    expect(asked).not.toContain(".claude-empty");
    expect(asked).not.toContain(".claude-file");
  });

  it("declares a found profile under the next free id and pools it", async () => {
    const { logins, accounts, home } = withProfiles();
    const [, ten] = await logins.found();
    await expect(logins.adopt({ configDir: ten.configDir })).resolves.toEqual({
      accountId: "perso-2",
      label: "ten",
    });
    expect(accounts.config().accounts.at(-1)).toEqual({
      id: "perso-2",
      provider: "claude",
      label: "ten",
      configDir: join(home, ".claude-10"),
    });
    expect(accounts.config().balance).toEqual(["perso-1", "perso-2"]);
    expect((await logins.found()).map((entry) => entry.label)).toEqual(["two"]);
  });

  it("refuses a folder it did not offer", async () => {
    const { logins, home } = withProfiles();
    await expect(logins.adopt({ configDir: join(home, ".claude-out") })).rejects.toThrow("not signed in");
    await expect(logins.adopt({ configDir: join(home, ".claude-1") })).rejects.toThrow("not signed in");
    await expect(logins.adopt({ configDir: "/etc" })).rejects.toThrow("not signed in");
  });
});
