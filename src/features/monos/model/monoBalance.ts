import type { ProviderRateLimits } from "../../providers/model/rateLimits";

/** The phone's and the account menu's name for the Balanced choice. */
export const MONO_BALANCED_ACCOUNT = "auto";

/** What one account has left, as its cached plan windows say. */
export type AccountRoom = {
  id: string;
  limits: Pick<ProviderRateLimits, "session" | "weekly" | "error">;
};

const used = (window: ProviderRateLimits["session"], now: number) =>
  !window ? undefined : window.resetsAt != null && window.resetsAt <= now ? 0 : window.usedPercent;

/**
 * The account a balanced Colleague should run on: one with room in both
 * windows, the most weekly room first, then the most 5-hour room. An account
 * whose usage could not be read, or was never read, comes after the known
 * ones. `except` leaves out the account a limit just stopped.
 */
export function pickBalancedAccount(
  accounts: readonly AccountRoom[],
  { except, now = Date.now() }: { except?: string; now?: number } = {},
): string | undefined {
  const ranked = accounts
    .filter((account) => account.id !== except && !account.limits.error)
    .map((account) => ({
      id: account.id,
      session: used(account.limits.session, now),
      weekly: used(account.limits.weekly, now),
    }))
    .filter((account) => (account.session ?? 0) < 100 && (account.weekly ?? 0) < 100)
    .sort(
      (a, b) =>
        Number(a.weekly === undefined) - Number(b.weekly === undefined) ||
        (a.weekly ?? 0) - (b.weekly ?? 0) ||
        (a.session ?? 0) - (b.session ?? 0),
    );
  return ranked[0]?.id;
}
