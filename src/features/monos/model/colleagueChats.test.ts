import { describe, expect, it } from "vitest";
import { newSession, type Session } from "../../sessions/model/session";
import { colleagueChatAgents } from "./colleagueChats";

function chat(id: string, patch: Partial<Session> = {}): Session {
  return {
    ...newSession("claude", "~"),
    id,
    blocks: [{ id: "u", role: "user", text: "hi", startedAt: 1 }],
    ...patch,
  };
}

const asking = {
  pendingQuestion: {
    requestId: "q",
    title: "Which one?",
    questions: [{ prompt: "Which one?", options: [] }],
  },
} as unknown as Partial<Session>;

const colleagues = [{ id: "m", name: "CTO", threadIds: ["open", "old"] }];

describe("colleagueChatAgents", () => {
  it("lists a chat that works and one that asks, named for its colleague", () => {
    const rows = colleagueChatAgents(
      [chat("open", { busy: true }), chat("old", asking), chat("other", asking)],
      colleagues,
    );
    expect(rows.map((row) => row.id)).toEqual(["old", "open"]);
    expect(rows[0]).toMatchObject({ needsApproval: true, colleague: { id: "m", name: "CTO" } });
    expect(rows[1]).toMatchObject({ needsApproval: false, colleague: { id: "m", name: "CTO" } });
  });

  it("leaves out an idle chat", () => {
    expect(colleagueChatAgents([chat("open")], colleagues)).toEqual([]);
  });

  it("lists a chat with a reply not read yet as done, in any thread", () => {
    const rows = colleagueChatAgents(
      [chat("open"), chat("old"), chat("other")],
      colleagues,
      new Map([["old", 2], ["other", 1], ["open", 0]]),
    );
    expect(rows.map((row) => row.id)).toEqual(["old"]);
    expect(rows[0]).toMatchObject({ done: true, colleague: { id: "m", name: "CTO" } });
  });

  it("shows a chat that works again as working, not done", () => {
    const rows = colleagueChatAgents(
      [chat("open", { busy: true })],
      colleagues,
      new Map([["open", 1]]),
    );
    expect(rows[0]).toMatchObject({ done: false, needsApproval: false });
  });
});
