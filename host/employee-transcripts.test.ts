import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostEmployeeTranscripts } from "./employee-transcripts";

const opened: Array<{ root: string; chats: HostEmployeeTranscripts }> = [];
afterEach(() => {
  for (const { root, chats } of opened.splice(0)) {
    chats.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function transcripts() {
  const root = mkdtempSync(join(tmpdir(), "side-transcripts-"));
  const chats = new HostEmployeeTranscripts(join(root, "employees", "transcripts.db"));
  opened.push({ root, chats });
  return chats;
}

const header = (id = "s1") => ({
  id,
  cwd: "/Users/me",
  harness: "claude",
  model: "claude:opus",
  modelSettings: {},
  runtimeMode: "auto",
  title: "Employee",
  providerSessionId: "p-1",
  queuedMessages: [],
});

const turns = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => [
    { id: `u${from + index}`, role: "user", text: `Question ${from + index}` },
    { id: `a${from + index}`, role: "assistant", text: `Answer ${from + index}` },
  ]).flat();

const ids = (blocks: unknown[]) => blocks.map((block) => (block as { id: string }).id);

it("saves a chat and opens it on its newest ten turns", () => {
  const chats = transcripts();
  expect(chats.get("s1")).toBeNull();
  const summary = chats.upsert({ session: { ...header(), blocks: turns(0, 12) }, blocksChanged: true });
  expect(summary).toMatchObject({ id: "s1", providerSessionId: "p-1", draft: false });
  const record = chats.get("s1")!;
  expect(ids(record.blocks as unknown[])).toEqual(ids(turns(2, 10)));
  expect(record.monoTranscript).toEqual({ before: 5, firstBlockId: "u2" });
  expect(record.providerSessionId).toBe("p-1");
  const older = chats.page("s1", { before: 5 });
  expect(ids(older.blocks)).toEqual(ids(turns(0, 2)));
  expect(older).toMatchObject({ before: null, hasNewer: true });
  expect(ids(chats.page("s1", { beforeBlockId: "u2" }).blocks)).toEqual(ids(turns(0, 2)));
  expect(chats.find("s1", "ANSWER 11")).toEqual(["a11"]);
});

it("replaces only the suffix after the writer's anchor", () => {
  const chats = transcripts();
  chats.upsert({ session: { ...header(), blocks: turns(0, 2) }, blocksChanged: true });
  chats.upsert({
    session: { ...header(), blocks: [{ id: "a1", role: "assistant", text: "Edited" }, ...turns(2, 1)] },
    afterBlockId: "u1",
    baseLastBlockId: "a1",
    blocksChanged: true,
  });
  const blocks = chats.get("s1")!.blocks as Array<{ id: string; text: string }>;
  expect(ids(blocks)).toEqual(["u0", "a0", "u1", "a1", "u2", "a2"]);
  expect(blocks[3].text).toBe("Edited");
  expect(() =>
    chats.upsert({ session: { ...header(), blocks: [] }, afterBlockId: "missing", baseLastBlockId: "a2", blocksChanged: true }),
  ).toThrow("anchor");
});

it("merges a save from a desktop that missed another's blocks, losing none", () => {
  const chats = transcripts();
  chats.upsert({ session: { ...header(), blocks: turns(0, 1) }, blocksChanged: true });
  // The Pro appends a turn.
  chats.upsert({ session: { ...header(), blocks: turns(1, 1) }, afterBlockId: "a0", baseLastBlockId: "a0", blocksChanged: true });
  // The Air, which last saw a0, rewrites a0 and adds its own turn.
  chats.upsert({
    session: { ...header(), blocks: [{ id: "a0", role: "assistant", text: "Air's a0" }, ...turns(9, 1)] },
    afterBlockId: "u0",
    baseLastBlockId: "a0",
    blocksChanged: true,
  });
  const blocks = chats.get("s1")!.blocks as Array<{ id: string; text: string }>;
  expect(ids(blocks)).toEqual(["u0", "a0", "u1", "a1", "u9", "a9"]);
  expect(blocks[1].text).toBe("Air's a0");
  expect(chats.page("s1", { aroundBlockId: "u9" }).hasNewer).toBe(false);
});

it("keeps a habit post and a handoff on turns of their own, and deletes a chat", () => {
  const chats = transcripts();
  chats.upsert({
    session: {
      ...header(),
      blocks: [
        ...turns(0, 1),
        { id: "h1", role: "assistant", text: "From a habit", monoHabit: { id: "x" } },
        { id: "ho", role: "handoff", text: "Handed off" },
        { id: "after", role: "assistant", text: "After" },
        { id: "d", role: "user", text: "Draft", draft: true },
      ],
    },
    blocksChanged: true,
  });
  const summary = chats.upsert({ session: header(), blocksChanged: false });
  expect(summary.draft).toBe(true);
  expect(ids(chats.page("s1", { aroundBlockId: "h1" }).blocks)).toEqual(["u0", "a0", "h1"]);
  chats.delete("s1");
  expect(chats.get("s1")).toBeNull();
  expect(() => chats.upsert({ session: { ...header("../x"), blocks: [] } })).toThrow("Invalid session ID");
});
