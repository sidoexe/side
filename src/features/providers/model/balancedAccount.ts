/**
 * The one rule every Balanced choice follows, on the desktop (Colleagues and
 * chats) and on a host (remote chats): which account should take the next
 * turn. Pure and dependency-free so the host bundles it as is.
 */

/** Above this much of the 5-hour window used, an account is kept for last. */
export const BALANCED_FIVE_HOUR_GUARD = 90;

export type BalancedCandidate = {
  id: string;
  /** Percent of the 5-hour window used now; undefined when unknown. */
  fiveHour?: number;
  /** Percent of the weekly window used now; undefined when unknown. */
  weekly?: number;
  /** Its usage has been read at least once. */
  read: boolean;
  /** Its usage could not be read, as when its sign-in expired. */
  error?: boolean;
  /** A limit stopped it until this time (ms). */
  blockedUntil?: number;
};

/**
 * Usable accounts, best first: never one in error, blocked or out of either
 * window. Known ones come before never-read ones; among them, those under the
 * 5-hour guard first, then the most weekly room, then the most 5-hour room.
 */
export function rankBalancedAccounts(
  candidates: readonly BalancedCandidate[],
  { now = Date.now(), exclude = [] }: { now?: number; exclude?: readonly string[] } = {},
): string[] {
  const hot = (account: BalancedCandidate) =>
    (account.fiveHour ?? 0) >= BALANCED_FIVE_HOUR_GUARD;
  return candidates
    .filter(
      (account) =>
        !exclude.includes(account.id) &&
        !account.error &&
        !(account.blockedUntil && account.blockedUntil > now) &&
        (account.fiveHour ?? 0) < 100 &&
        (account.weekly ?? 0) < 100,
    )
    .sort(
      (a, b) =>
        Number(!a.read) - Number(!b.read) ||
        Number(hot(a)) - Number(hot(b)) ||
        (a.weekly ?? 0) - (b.weekly ?? 0) ||
        (a.fiveHour ?? 0) - (b.fiveHour ?? 0),
    )
    .map((account) => account.id);
}
