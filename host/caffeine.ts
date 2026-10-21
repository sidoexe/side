import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Caffeine mode: keeps this machine from idle-sleeping while it is on, so a
 * desktop can leave long turns running here. The blocker is a child process
 * (`caffeinate` on macOS, `systemd-inhibit` on Linux); stopping it, or this
 * host exiting, lets the machine sleep again.
 */

export type CaffeineCommand = { command: string; args: string[] };

/** How this machine holds off sleep, or nothing where it cannot. */
export function caffeineCommand(
  platform: NodeJS.Platform = process.platform,
  pid = process.pid,
  find: (name: string) => string | undefined = onPath,
): CaffeineCommand | undefined {
  if (platform === "darwin")
    // `-w` ends it with this host even when the host is killed.
    return { command: "/usr/bin/caffeinate", args: ["-i", "-w", String(pid)] };
  if (platform !== "linux") return undefined;
  const command = find("systemd-inhibit");
  if (!command) return undefined;
  return {
    command,
    args: ["--what=idle:sleep", "--who=sIDE Host", "--why=Caffeine mode", "--mode=block", "sleep", "infinity"],
  };
}

function onPath(name: string): string | undefined {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .concat("/usr/bin", "/bin")
    .filter(Boolean)
    .map((dir) => join(dir, name))
    .find((path) => existsSync(path));
}

/** A blocker that exits this soon was refused (no polkit right, no logind). */
const SETTLE_MS = 300;

export class HostCaffeine {
  private child?: ChildProcess;

  constructor(private readonly blocker: CaffeineCommand) {}

  status(): { on: boolean } {
    return { on: this.running() };
  }

  async set(params: Record<string, unknown>): Promise<{ on: boolean }> {
    if (typeof params.on !== "boolean") throw new Error("Caffeine needs on: true or false");
    if (!params.on) this.close();
    else if (!this.running()) await this.start();
    return this.status();
  }

  close(): void {
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
  }

  private running(): boolean {
    const child = this.child;
    return !!child && child.exitCode === null && child.signalCode === null;
  }

  private start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.blocker.command, this.blocker.args, {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 2000) stderr += chunk.toString();
      });
      const fail = (reason: string) => {
        clearTimeout(timer);
        if (this.child === child) this.child = undefined;
        reject(new Error(`Cannot keep this machine awake${reason ? `: ${reason}` : ""}`));
      };
      child.once("error", (error) => fail(error.message));
      child.once("exit", () => fail(stderr.trim()));
      const timer = setTimeout(() => {
        child.removeAllListeners("exit");
        child.removeAllListeners("error");
        // Errors after it settled only end it; `running()` reads that.
        child.on("error", () => {});
        child.stderr?.removeAllListeners("data");
        child.stderr?.resume();
        resolve();
      }, SETTLE_MS);
      this.child = child;
    });
  }
}
