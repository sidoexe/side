import { loginHarness } from "../../../integrations/harness/core/auth";
import { HARNESS_TITLE } from "../../sessions/model/session";
import type { ProviderAccountProvider } from "./providerAccounts";
import {
  errorRateLimits,
  type ProviderRateLimits,
  type RateLimitProvider,
} from "./rateLimits";
import {
  getCachedRateLimits,
  loadRateLimits,
  setCachedRateLimits,
} from "./rateLimitsCache";

/** Whether an account's last reading says it must sign in again. */
export function needsProviderLogin(limits: ProviderRateLimits | undefined): boolean {
  // An account not read yet has nothing to say.
  if (!limits) return false;
  if (limits.status === "unavailable") return true;
  if (limits.status !== "error") return false;
  const text = limits.error?.toLowerCase() ?? "";
  return (
    text.includes("expired") ||
    text.includes("sign-in") ||
    text.includes("not signed in") ||
    text.includes("not connected") ||
    text.includes("authentication")
  );
}

/**
 * Runs the provider's own browser sign-in for one account, then reads its
 * usage to be sure it took. A failure is kept as the account's reading, so
 * every place that shows the account says why.
 */
export async function signInProviderAccount(
  provider: RateLimitProvider | ProviderAccountProvider,
  accountId: string,
): Promise<void> {
  try {
    await (accountId === "default"
      ? loginHarness(provider)
      : loginHarness(provider, accountId));
    const value = await loadRateLimits(provider, accountId, true);
    if (value.status !== "ok")
      throw new Error(
        value.error ||
          `${HARNESS_TITLE[provider]} sign-in could not be verified`,
      );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not complete sign-in";
    setCachedRateLimits(
      provider,
      accountId,
      errorRateLimits(
        provider,
        message,
        getCachedRateLimits(provider, accountId),
      ),
    );
    throw error;
  }
}
