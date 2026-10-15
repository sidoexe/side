import { describe, expect, it } from "vitest";
import { cookieDigest, shouldShare } from "./webAppsSync";

describe("web app login sync", () => {
  const signedIn = ["session=abc; HttpOnly; Secure", "theme=dark; Path=/"];

  it("reads cookies by name and value, whatever their order and attributes", () => {
    expect(cookieDigest(signedIn)).toEqual(
      cookieDigest(["theme=dark", "session=abc; Domain=linear.app"]),
    );
    const refreshed = cookieDigest(["session=xyz", "theme=dark"]);
    expect(refreshed.names).toBe(cookieDigest(signedIn).names);
    expect(refreshed.values).not.toBe(cookieDigest(signedIn).values);
  });

  it("shares a sign-in at once and a refreshed token now and then", () => {
    const digest = cookieDigest(signedIn);
    const mark = { updatedAt: 1, ...digest, sentAt: 1_000 };
    expect(shouldShare(undefined, digest, 1_000)).toBe(true);
    expect(shouldShare(mark, digest, 10_000_000)).toBe(false);
    expect(shouldShare(mark, cookieDigest(["theme=dark"]), 1_001)).toBe(true);
    const refreshed = cookieDigest(["session=xyz", "theme=dark"]);
    expect(shouldShare(mark, refreshed, 60_000)).toBe(false);
    expect(shouldShare(mark, refreshed, 1_000 + 5 * 60_000)).toBe(true);
  });
});
