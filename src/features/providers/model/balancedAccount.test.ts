import { describe, expect, it } from "vitest";
import { rankBalancedAccounts } from "./balancedAccount";

describe("balanced account rule", () => {
  it("never picks an account in error, blocked, excluded or used up", () => {
    expect(
      rankBalancedAccounts(
        [
          { id: "expired", read: true, error: true, weekly: 0 },
          { id: "blocked", read: true, blockedUntil: 2_000 },
          { id: "stopped", read: true },
          { id: "full", read: true, weekly: 100 },
          { id: "ok", read: true, weekly: 80 },
        ],
        { now: 1_000, exclude: ["stopped"] },
      ),
    ).toEqual(["ok"]);
  });

  it("prefers known accounts under the 5-hour guard, then weekly room", () => {
    expect(
      rankBalancedAccounts([
        { id: "unread", read: false },
        { id: "hot", read: true, fiveHour: 95, weekly: 0 },
        { id: "busy", read: true, fiveHour: 10, weekly: 60 },
        { id: "roomy", read: true, fiveHour: 50, weekly: 20 },
      ]),
    ).toEqual(["roomy", "busy", "hot", "unread"]);
  });
});
