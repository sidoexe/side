import {
  liveAgentsFromSessions,
  type LiveAgent,
} from "../../sessions/model/liveAgents";
import type { Session } from "../../sessions/model/session";

/**
 * The colleagues' own chats that work, wait on the user or hold a reply not
 * read yet, one row per thread and named for its colleague. A thread left
 * behind for a new one still counts. A reply read in the chat, or checked on
 * the board, leaves `unread`.
 */
export function colleagueChatAgents(
  sessions: readonly Session[],
  colleagues: readonly { id: string; name: string; threadIds: readonly string[] }[],
  unread: ReadonlyMap<string, number> = new Map(),
): LiveAgent[] {
  const owner = new Map(
    colleagues.flatMap(({ id, name, threadIds }) =>
      threadIds.map((threadId): [string, { id: string; name: string }] => [
        threadId,
        { id, name },
      ]),
    ),
  );
  return liveAgentsFromSessions(
    sessions.filter((session) => owner.has(session.id)),
    new Set([...unread].flatMap(([id, count]) => (count > 0 ? id : []))),
  ).flatMap((row) => {
    const colleague = owner.get(row.id);
    return colleague ? [{ ...row, colleague }] : [];
  });
}
