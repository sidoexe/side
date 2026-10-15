import { useEffect, useRef, useSyncExternalStore } from "react";
import { isMonoSession } from "../../monos/model/mono";
import { isLiveAgentSession } from "../model/liveAgents";
import type { Session } from "../model/session";
import { nextUnseenFinishedSessions } from "../model/sessionDone";
import {
  replaceSessionsToReview,
  sessionsToReview,
  subscribeSessionsToReview,
} from "../model/sessionReview";

/** Sessions done and waiting to be checked, kept across restarts. */
export function useUnseenFinishedSessions(
  sessions: Session[],
  busySessionIds: ReadonlySet<string>,
): Set<string> {
  const stored = useSyncExternalStore(
    subscribeSessionsToReview,
    sessionsToReview,
  );
  const busyForDoneRef = useRef(busySessionIds);
  const storedRef = useRef(stored);
  const unseenFinishedRef = useRef<Set<string>>(new Set(stored.keys()));
  if (storedRef.current !== stored) {
    storedRef.current = stored;
    const current = unseenFinishedRef.current;
    if (
      current.size !== stored.size ||
      [...current].some((id) => !stored.has(id))
    )
      unseenFinishedRef.current = new Set(stored.keys());
  }
  if (busyForDoneRef.current !== busySessionIds) {
    unseenFinishedRef.current = nextUnseenFinishedSessions({
      previousBusyIds: busyForDoneRef.current,
      busyIds: busySessionIds,
      previousUnseenIds: unseenFinishedRef.current,
      // A Colleague's chat and its habit runs report through the Colleague.
      untrackedIds: new Set(
        sessions
          .filter(
            (session) =>
              !isLiveAgentSession(session) ||
              session.ephemeral ||
              isMonoSession(session.id),
          )
          .map((session) => session.id),
      ),
    });
    busyForDoneRef.current = busySessionIds;
  }
  const unseenFinished = unseenFinishedRef.current;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  useEffect(() => {
    replaceSessionsToReview(
      unseenFinished,
      (id) => sessionsRef.current.find((session) => session.id === id)?.cwd,
    );
  }, [unseenFinished]);
  return unseenFinished;
}
