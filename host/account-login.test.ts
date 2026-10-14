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
function fakeClaude(onCode: (code: string, call: Call) => void) {
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
        child.stdout.write(JSON.stringify({ loggedIn: true, email: "new.person@example.com" }));
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

function setup(onCode: (code: string, call: Call) => void, config?: unknown) {
  const data = temp();
  const home = temp();
  if (config) writeFileSync(join(data, "config.json"), JSON.stringify(config));
  const accounts = new HostAccounts(data);
  const claude = fakeClaude(onCode);
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
