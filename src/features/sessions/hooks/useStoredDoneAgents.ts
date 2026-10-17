import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  listSessionsByProject,
  type SessionSummary,
} from "../data/sessionStore";
import { storedDoneAgents, type LiveAgent } from "../model/liveAgents";
import { sessionsToReview, subscribeSessionsToReview } from "../model/sessionReview";

/**
 * Rail rows for done sessions that are not loaded, as after a restart, so
 * every session a project counts as done can be opened from the rail.
 */
export function useStoredDoneAgents(
  loadedIds: ReadonlySet<string>,
  enabled: boolean,
): LiveAgent[] {
  const stored = useSyncExternalStore(
    subscribeSessionsToReview,
    sessionsToReview,
  );
  const [summaries, setSummaries] = useState<
    ReadonlyMap<string, SessionSummary>
  >(new Map());
  const missingFolders = useMemo(() => {
    const folders = new Set<string>();
    for (const [id, cwd] of stored)
      if (cwd && !loadedIds.has(id) && !summaries.has(id)) folders.add(cwd);
    return [...folders].sort().join("\0");
  }, [stored, loadedIds, summaries]);

  useEffect(() => {
    if (!enabled || !missingFolders) return;
    let alive = true;
    void Promise.all(
      missingFolders
        .split("\0")
        .map((cwd) => listSessionsByProject(cwd).catch(() => [])),
    ).then((lists) => {
      if (!alive) return;
      const wanted = sessionsToReview();
      setSummaries((current) => {
        const next = new Map(current);
        for (const row of lists.flat())
          if (wanted.has(row.id)) next.set(row.id, row);
        return next.size === current.size ? current : next;
      });
    });
    return () => {
      alive = false;
    };
  }, [enabled, missingFolders]);

  return useMemo(
    () =>
      enabled ? storedDoneAgents(stored, loadedIds, summaries) : [],
    [enabled, stored, loadedIds, summaries],
  );
}
