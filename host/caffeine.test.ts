import { describe, expect, it } from "vitest";
import { caffeineCommand, HostCaffeine } from "./caffeine";

describe("caffeineCommand", () => {
  it("holds off idle sleep on macOS until this host exits", () => {
    expect(caffeineCommand("darwin", 42)).toEqual({
      command: "/usr/bin/caffeinate",
      args: ["-i", "-w", "42"],
    });
  });

  it("uses systemd-inhibit on Linux, and nothing without it", () => {
    expect(caffeineCommand("linux", 1, () => "/usr/bin/systemd-inhibit")?.command).toBe(
      "/usr/bin/systemd-inhibit",
    );
    expect(caffeineCommand("linux", 1, () => undefined)).toBeUndefined();
    expect(caffeineCommand("win32")).toBeUndefined();
  });
});

describe("HostCaffeine", () => {
  it("runs the blocker while on and stops it when off", async () => {
    const caffeine = new HostCaffeine({ command: "sleep", args: ["30"] });
    expect(caffeine.status()).toEqual({ on: false });
    expect(await caffeine.set({ on: true })).toEqual({ on: true });
    expect(await caffeine.set({ on: true })).toEqual({ on: true });
    expect(await caffeine.set({ on: false })).toEqual({ on: false });
  });

  it("reports a blocker that is refused", async () => {
    const caffeine = new HostCaffeine({
      command: "sh",
      args: ["-c", "echo 'Access denied' >&2; exit 1"],
    });
    await expect(caffeine.set({ on: true })).rejects.toThrow(
      "Cannot keep this machine awake: Access denied",
    );
    expect(caffeine.status()).toEqual({ on: false });
  });

  it("rejects a request without on", async () => {
    const caffeine = new HostCaffeine({ command: "sleep", args: ["30"] });
    await expect(caffeine.set({})).rejects.toThrow("on: true or false");
  });
});
