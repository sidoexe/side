import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorRateLimits, type ProviderRateLimits } from "./rateLimits";

const fetchClaude = vi.fn<() => Promise<ProviderRateLimits>>();
vi.mock("./rateLimitsFetch", () => ({
  fetchClaudeRateLimits: () => fetchClaude(),
  fetchCodexRateLimits: vi.fn(),
  fetchDevinRateLimits: vi.fn(),
  fetchOpencodeGoRateLimits: vi.fn(),
}));

const { clearCachedRateLimits, loadRateLimits } = await import(
  "./rateLimitsCache"
);

const reading = (usedPercent: number): ProviderRateLimits => ({
  provider: "claude",
  session: { usedPercent, windowMinutes: 300, resetsAt: null },
  weekly: null,
  monthly: null,
  resetCredits: null,
  updatedAt: Date.now(),
  error: null,
  status: "ok",
});

describe("reading usage", () => {
  beforeEach(() => {
    clearCachedRateLimits();
    fetchClaude.mockReset();
  });

  it("keeps the last reading when the provider refuses one, and waits", async () => {
    fetchClaude.mockResolvedValueOnce(reading(40));
    await loadRateLimits("claude", "a");
    fetchClaude.mockResolvedValue({
      ...errorRateLimits("claude", "limited"),
      retry: true,
    });
    const kept = await loadRateLimits("claude", "a", true);
    expect(kept.error).toBeNull();
    expect(kept.session?.usedPercent).toBe(40);
    await loadRateLimits("claude", "a", true);
    expect(fetchClaude).toHaveBeenCalledTimes(2);
  });

  it("lets a stale refresh reuse a reading under a minute old", async () => {
    fetchClaude.mockResolvedValue(reading(10));
    await loadRateLimits("claude", "b");
    await loadRateLimits("claude", "b", "stale");
    expect(fetchClaude).toHaveBeenCalledTimes(1);
    await loadRateLimits("claude", "b", true);
    expect(fetchClaude).toHaveBeenCalledTimes(2);
  });
});
