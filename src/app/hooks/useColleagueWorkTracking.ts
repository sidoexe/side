import { useEffect, useMemo, useRef, useState } from "react";
import {
  LIVE_STALE_MS,
  recordColleagueWork,
  type ColleagueLaunch,
  type LiveLaunch,
} from "../../features/monos/model/colleagueWork";
import { listMonos, monoState, monoThreads } from "../../features/monos/model/mono";
import { habitRunMono } from "../../features/monos/model/monoHabits";
import {
  launchedSessionState,
  monoSpawnedSessions,
} from "../../features/monos/model/monoSpawnedSessions";
import type {
  Block,
  MonoSpawnedSession,
  Session,
} from "../../features/sessions/model/session";

/** A chat's blocks change on every streamed token; its launches rarely do. */
const launchesByBlocks = new WeakMap<readonly Block[], MonoSpawnedSession[]>();

function launchesOf(blocks: readonly Block[]): MonoSpawnedSession[] {
  let found = launchesByBlocks.get(blocks);
  if (!found) {
    found = monoSpawnedSessions(blocks);
    launchesByBlocks.set(blocks, found);
  }
  return found;
}

type Pass = [monoId: string, launches: ColleagueLaunch[], live: [string, LiveLaunch][]];

/**
 * Keeps each colleague's work list in step with this window: the sessions
 * its open conversations started and its habits' runs, with where each
 * stands now.
 */
export function useColleagueWorkTracking(
  sessions: readonly Session[],
  enabled: boolean,
): void {
  const seenLive = useRef(new Set<string>());
  // Looks again now and then, so one that ended unseen settles even while
  // nothing else changes.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), LIVE_STALE_MS / 2);
    return () => clearInterval(timer);
  }, []);

  // Rebuilt on every change, compared as text so a streamed token that moves
  // nothing writes nothing.
  const key = useMemo(() => {
    if (!enabled) return "";
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const passes: Pass[] = listMonos().map((mono) => {
      const launches: ColleagueLaunch[] = monoThreads(mono).flatMap((thread) => {
        const chat = byId.get(thread.id);
        return chat
          ? launchesOf(chat.blocks).map((launch) => ({ launch, thread: thread.id }))
          : [];
      });
      for (const session of sessions)
        if (session.ephemeral && habitRunMono(session.id) === mono.id)
          launches.push({
            launch: {
              sessionId: session.id,
              cwd: session.cwd,
              title: session.title,
              harness: session.harness,
              model: session.model,
            },
            thread: "",
            habit: true,
          });
      const live = launches.flatMap(({ launch }): [string, LiveLaunch][] => {
        const session = byId.get(launch.sessionId);
        if (!session) return [];
        const state = launchedSessionState(session);
        const { activity } = monoState(session);
        return [
          [
            session.id,
            {
              state,
              title: session.title,
              ...(activity && (state === "working" || state === "input")
                ? { activity }
                : {}),
            },
          ],
        ];
      });
      return [mono.id, launches, live];
    });
    return JSON.stringify(passes);
  }, [sessions, enabled]);

  useEffect(() => {
    if (!key) return;
    const passes = JSON.parse(key) as Pass[];
    const now = Date.now();
    for (const [monoId, launches, live] of passes) {
      for (const [id] of live) seenLive.current.add(id);
      // Seen here and no longer open here: it ended in this window.
      recordColleagueWork(monoId, launches, new Map(live), now, (id) =>
        seenLive.current.has(id),
      );
    }
  }, [key, tick]);
}
