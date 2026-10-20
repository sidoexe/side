import { describe, expect, it } from "vitest";
import {
  nextBalancedAccount,
  pickBalancedAccount,
  type AccountRoom,
} from "./accountBalance";

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

describe("balanced accounts", () => {
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

  it("keeps an account near its 5-hour limit for last", () => {
    expect(pickBalancedAccount([account("hot", 95, 10), account("cool", 20, 50)])).toBe("cool");
    expect(pickBalancedAccount([account("hot", 95, 10), account("full", 100, 0)])).toBe("hot");
  });
});

describe("balanced conversation before a turn", () => {
  it("stays on a usable account under the 5-hour guard", () => {
    expect(nextBalancedAccount([account("a", 40, 60), account("b", 10, 20)], "a")).toBeUndefined();
    expect(nextBalancedAccount([account("a", 40, 60), account("unknown")], "unknown")).toBeUndefined();
  });

  it("leaves a full, unreadable, removed or hot account for the best one", () => {
    const others = [account("b", 10, 20), account("c", 5, 50)];
    expect(nextBalancedAccount([account("a", 100, 10), ...others], "a")).toBe("b");
    expect(nextBalancedAccount([account("a", 0, 0, "Sign-in expired"), ...others], "a")).toBe("b");
    expect(nextBalancedAccount(others, "removed")).toBe("b");
    expect(nextBalancedAccount([account("a", 92, 10), ...others], "a")).toBe("b");
  });

  it("stays when nothing better is free", () => {
    expect(nextBalancedAccount([account("a", 92, 10), account("b", 95, 0)], "a")).toBeUndefined();
    expect(nextBalancedAccount([account("a", 100, 10), account("b", 100, 0)], "a")).toBeUndefined();
  });
});
