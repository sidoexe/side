import { describe, expect, it } from "vitest";
import { pickBalancedAccount, type AccountRoom } from "./monoBalance";

const window = (usedPercent: number, resetsAt: number | null = null) => ({
  usedPercent,
  windowMinutes: 300,
  resetsAt,
});
const account = (id: string, session?: number, weekly?: number, error?: string): AccountRoom => ({
  id,
  limits: {
    session: session === undefined ? null : window(session),
    weekly: weekly === undefined ? null : window(weekly),
    error: error ?? null,
  },
});

describe("balanced Colleague accounts", () => {
  it("takes the most weekly room, then the most 5-hour room", () => {
    expect(
      pickBalancedAccount([account("a", 10, 60), account("b", 50, 20), account("c", 5, 20)]),
    ).toBe("c");
  });

  it("skips a full, unreadable or just-limited account, and unknown ones go last", () => {
    expect(
      pickBalancedAccount(
        [
          account("full", 100, 10),
          account("broken", 0, 0, "Sign-in expired"),
          account("unknown"),
          account("busy", 40, 90),
          account("stopped", 0, 0),
        ],
        { except: "stopped" },
      ),
    ).toBe("busy");
    expect(pickBalancedAccount([account("unknown"), account("full", 100, 100)])).toBe("unknown");
  });

  it("counts a window past its reset as empty, and finds none when all are out", () => {
    const now = 1_000;
    expect(
      pickBalancedAccount(
        [{ id: "reset", limits: { session: window(100, 500), weekly: window(30), error: null } }],
        { now },
      ),
    ).toBe("reset");
    expect(pickBalancedAccount([account("a", 100, 0), account("b", 0, 100)])).toBeUndefined();
  });
});
