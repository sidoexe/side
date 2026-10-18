import { describe, expect, it } from "vitest";
import { newSession, type Session } from "./session";
import { carrySessionAccount, switchSessionAccount } from "./accountSwitch";

const chat = (overrides: Partial<Session> = {}): Session => ({
  ...newSession("claude", "/tmp/project", "sonnet", "default", {}),
  blocks: [{ id: "u1", role: "user", text: "hello" }],
  providerSessionId: "thread-1",
  providerAccountId: "work",
  ...overrides,
});

describe("moving a chat to another account", () => {
  it("hands the conversation over without contacting the old account", () => {
    const moved = switchSessionAccount(chat(), "personal");
    expect(moved.providerAccountId).toBe("personal");
    expect(moved.providerSessionId).toBeUndefined();
    expect(moved.pendingSwitch).toMatchObject({
      from: "claude",
      fromProviderAccountId: "work",
      fromProviderSessionId: "thread-1",
      skipOutgoingRecap: true,
    });
  });

  it("carries a Claude chat on its own thread, and leaves a limit for the caller", () => {
    const limited = chat({ usageLimit: { resetsAt: 1_000 } });
    const moved = carrySessionAccount(limited, "personal");
    expect(moved).toMatchObject({
      providerAccountId: "personal",
      providerSessionId: "thread-1",
    });
    expect(moved.usageLimit).toBe(limited.usageLimit);
    expect(
      carrySessionAccount(chat({ busy: true }), "personal").providerAccountId,
    ).toBe("work");
    expect(
      carrySessionAccount(chat({ harness: "codex" }), "personal")
        .providerAccountId,
    ).toBe("work");
  });
});
