import { expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { launchAgent, systemdUnit, uninstallService } from "./service";

it("keeps paths and environment content from injecting service configuration", () => {
  const options = {
    directory: "/Users/a & b/%folder",
    port: 3775,
    executable: '/runtime/a"b/node',
    entry: "/runtime/$name/host.mjs",
  };
  const plist = launchAgent(options, "/bin:<test>&other");
  expect(plist).toContain("a&quot;b/node");
  expect(plist).toContain("/bin:&lt;test&gt;&amp;other");
  expect(plist).not.toContain("<test>");
  const unit = systemdUnit(options, "/bin:/a\n[Service]\nExecStart=/bad");
  expect(unit.match(/^ExecStart=/gm)).toHaveLength(1);
  expect(unit).toContain("%%folder");
  expect(unit).toContain("$$name");
  expect(unit).toContain("KillMode=control-group");
});

it.each(["darwin", "linux"] as const)(
  "removes the %s service registration but keeps host data",
  async (platform) => {
    const home = mkdtempSync(join(tmpdir(), "monocode-service-test-"));
    try {
      const service =
        platform === "darwin"
          ? join(home, "Library/LaunchAgents/dev.sidoexe.side.host.plist")
          : join(home, ".config/systemd/user/side-host.service");
      const data = join(home, ".side-host/host.db");
      for (const file of [service, data]) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "existing");
      }
      const calls: string[][] = [];
      const notes = await uninstallService({
        platform,
        home,
        run: async (command, args) => {
          calls.push([command, ...args]);
          // A service that is not loaded must not block cleanup.
          if (args.includes("bootout") || args.includes("disable"))
            throw new Error("not loaded");
        },
      });
      expect(existsSync(service)).toBe(false);
      expect(readFileSync(data, "utf8")).toBe("existing");
      if (platform === "darwin")
        expect(calls[0].slice(0, 2)).toEqual(["launchctl", "bootout"]);
      else {
        expect(calls).toContainEqual([
          "systemctl",
          "--user",
          "disable",
          "--now",
          "side-host.service",
        ]);
        expect(notes.join("\n")).toContain("loginctl disable-linger");
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);
