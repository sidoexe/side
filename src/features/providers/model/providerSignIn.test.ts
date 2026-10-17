import { beforeEach, expect, it, vi } from "vitest";
import { idleRateLimits } from "./rateLimits";

const login = vi.fn();
const load = vi.fn();
vi.mock("../../../integrations/harness/core/auth", () => ({ loginHarness: (...args: unknown[]) => login(...args) }));
vi.mock("./rateLimitsCache", async (actual) => ({
  ...(await actual<typeof import("./rateLimitsCache")>()),
  loadRateLimits: (...args: unknown[]) => load(...args),
}));

const { needsProviderLogin, signInProviderAccount } = await import("./providerSignIn");
const { getCachedRateLimits } = await import("./rateLimitsCache");

beforeEach(() => {
  login.mockReset();
  load.mockReset();
});

it("knows an expired sign-in from other errors", () => {
  const error = (text: string) => ({ ...idleRateLimits("claude"), status: "error" as const, error: text });
  expect(needsProviderLogin(error("Claude sign-in expired"))).toBe(true);
  expect(needsProviderLogin(error("Rate limited by the API"))).toBe(false);
  expect(needsProviderLogin({ ...idleRateLimits("claude"), status: "ok" })).toBe(false);
});

it("signs one account in, checks it took, and keeps why it did not", async () => {
  login.mockResolvedValue(undefined);
  load.mockResolvedValueOnce({ ...idleRateLimits("claude"), status: "ok" });
  await signInProviderAccount("claude", "account-work");
  expect(login).toHaveBeenCalledWith("claude", "account-work");
  expect(load).toHaveBeenCalledWith("claude", "account-work", true);

  login.mockRejectedValueOnce(new Error("Browser closed"));
  await expect(signInProviderAccount("claude", "account-work")).rejects.toThrow("Browser closed");
  expect(getCachedRateLimits("claude", "account-work").error).toBe("Browser closed");
});
