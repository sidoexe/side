import type { ProviderRateLimits } from "../../providers/model/rateLimits";
import {
  BALANCED_FIVE_HOUR_GUARD,
  rankBalancedAccounts,
  type BalancedCandidate,
} from "../../providers/model/balancedAccount";

/** The phone's and the account menu's name for the Balanced choice. */
export const BALANCED_ACCOUNT = "auto";

/** What one account has left, as its cached plan windows say. */
export type AccountRoom = {
  id: string;
  limits: Pick<ProviderRateLimits, "session" | "weekly" | "error" | "retry">;
};

const used = (window: ProviderRateLimits["session"], now: number) =>
  !window ? undefined : window.resetsAt != null && window.resetsAt <= now ? 0 : window.usedPercent;

function candidate(account: AccountRoom, now: number): BalancedCandidate {
  const { session, weekly, error, retry } = account.limits;
  return {
    id: account.id,
    fiveHour: used(session, now),
    weekly: used(weekly, now),
    read: !!(session || weekly),
    // A refused reading says nothing about the account.
    error: !!error && !retry,
  };
}

/**
 * The account a balanced chat should run
 * on, by the shared Balanced rule. `except` leaves out the account a limit
 * just stopped.
 */
export function pickBalancedAccount(
  accounts: readonly AccountRoom[],
  { except, now = Date.now() }: { except?: string; now?: number } = {},
): string | undefined {
  return rankBalancedAccounts(
    accounts.map((account) => candidate(account, now)),
    { now, exclude: except ? [except] : [] },
  )[0];
}

/**
 * Where a balanced conversation should go before its next turn, or nothing
 * to stay. It keeps its account while that one is usable and under the
 * 5-hour guard, so the conversation is not handed back and forth over a few
 * points of weekly room.
 */
export function nextBalancedAccount(
  accounts: readonly AccountRoom[],
  current: string,
  { now = Date.now() }: { now?: number } = {},
): string | undefined {
  const candidates = accounts.map((account) => candidate(account, now));
  const ranked = rankBalancedAccounts(candidates, { now });
  const best = ranked[0];
  if (!best || best === current) return undefined;
  if (!ranked.includes(current)) return best;
  const hot = (id: string) =>
    (candidates.find((entry) => entry.id === id)?.fiveHour ?? 0) >=
    BALANCED_FIVE_HOUR_GUARD;
  return hot(current) && !hot(best) ? best : undefined;
}
