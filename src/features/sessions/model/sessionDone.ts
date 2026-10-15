/** Sessions that finished and wait to be checked, until they work again or
 * the user marks them checked. Watching one finish, or looking at it later,
 * keeps it done so the user is still reminded to follow up. */

export function nextUnseenFinishedSessions({
  previousBusyIds,
  busyIds,
  previousUnseenIds,
  untrackedIds,
}: {
  previousBusyIds: ReadonlySet<string>;
  busyIds: ReadonlySet<string>;
  previousUnseenIds: ReadonlySet<string>;
  /** Sessions the user cannot focus or see as done, such as orchestration
   * workers and inbox discussions. A done session stays loaded until it
   * works again, so marking one of these would keep it in memory for good. */
  untrackedIds?: ReadonlySet<string>;
}): Set<string> {
  const next = new Set(previousUnseenIds);
  for (const id of previousBusyIds) {
    if (!busyIds.has(id)) next.add(id);
  }
  for (const id of busyIds) next.delete(id);
  if (untrackedIds) for (const id of untrackedIds) next.delete(id);
  return next;
}

/**
 * How many replies each session finished while unfocused, until the user
 * looks at it. Unlike the done set, a count survives the session working
 * again, so replies keep adding up while the user is away.
 */
export function nextUnseenReplyCounts({
  previousBusyIds,
  busyIds,
  previousCounts,
  focusedSessionId,
  trackedIds,
}: {
  previousBusyIds: ReadonlySet<string>;
  busyIds: ReadonlySet<string>;
  previousCounts: ReadonlyMap<string, number>;
  focusedSessionId?: string;
  /** Only these sessions are counted; others are dropped. */
  trackedIds: ReadonlySet<string>;
}): Map<string, number> {
  const next = new Map(previousCounts);
  for (const id of previousBusyIds) {
    if (!busyIds.has(id) && id !== focusedSessionId && trackedIds.has(id))
      next.set(id, (next.get(id) ?? 0) + 1);
  }
  if (focusedSessionId) next.delete(focusedSessionId);
  for (const id of next.keys()) if (!trackedIds.has(id)) next.delete(id);
  return next;
}
