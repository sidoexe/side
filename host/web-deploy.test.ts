import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HostStore } from "./store";
import { deployWebRelease, RELEASES } from "./web-deploy";

/** A host package as a release publishes it, and the fetch that serves it. */
function release(version: string, packaged = version) {
  const directory = mkdtempSync(join(tmpdir(), "side-web-deploy-"));
  const folder = join(directory, "package");
  mkdirSync(join(folder, "web"), { recursive: true });
  mkdirSync(join(folder, "bin"));
  writeFileSync(join(folder, "web", "index.html"), `new ${version}`);
  writeFileSync(join(folder, "bin", "node"), "binary");
  writeFileSync(join(folder, "version.json"), JSON.stringify({ version: packaged }));
  const archive = join(directory, "side-host-darwin-arm64.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", folder, "."]);
  const bytes = readFileSync(archive);
  const urls: string[] = [];
  let checksum = `${createHash("sha256").update(bytes).digest("hex")}  side-host-darwin-arm64.tar.gz\n`;
  const fetcher = (async (url: string) => {
    urls.push(url);
    if (url.endsWith(".sha256")) return new Response(checksum);
    return new Response(bytes);
  }) as unknown as typeof fetch;
  const root = join(directory, "runtime", "web");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "index.html"), "old");
  return { root, fetcher, urls, corrupt: () => (checksum = "0".repeat(64)) };
}

describe("deployWebRelease", () => {
  it("installs the web folder of the release's package and keeps the previous one", async () => {
    const r = release("0.39.0");
    expect(await deployWebRelease("0.39.0", r.root, r.fetcher)).toEqual({ version: "0.39.0" });
    expect(readFileSync(join(r.root, "index.html"), "utf8")).toBe("new 0.39.0");
    expect(readFileSync(join(`${r.root}.previous`, "index.html"), "utf8")).toBe("old");
    // Only the web app: nothing else of the package lands next to it.
    expect(existsSync(join(r.root, "..", "bin"))).toBe(false);
    expect(r.urls).toEqual([`${RELEASES}/v0.39.0/side-host-darwin-arm64.tar.gz`, `${RELEASES}/v0.39.0/side-host-darwin-arm64.tar.gz.sha256`]);
  });

  it("refuses a package that does not match its checksum or its version", async () => {
    const corrupt = release("0.39.0");
    corrupt.corrupt();
    await expect(deployWebRelease("0.39.0", corrupt.root, corrupt.fetcher)).rejects.toThrow(/checksum/);
    expect(readFileSync(join(corrupt.root, "index.html"), "utf8")).toBe("old");
    const other = release("0.39.0", "0.38.0");
    await expect(deployWebRelease("0.39.0", other.root, other.fetcher)).rejects.toThrow(/not 0.39.0/);
    expect(readFileSync(join(other.root, "index.html"), "utf8")).toBe("old");
  });

  it("only takes a release version, never a path or a URL", async () => {
    const r = release("0.39.0");
    for (const version of ["../0.39.0", "0.39.0/../../x", "https://evil.example/x", "", 39])
      await expect(deployWebRelease(version, r.root, r.fetcher)).rejects.toThrow(/Invalid release version/);
    expect(r.urls).toEqual([]);
  });
});

describe("deploy key", () => {
  it("matches only the last key issued, until revoked", () => {
    const store = new HostStore(join(mkdtempSync(join(tmpdir(), "side-deploy-key-")), "host.db"));
    expect(store.deployKeyMatches("x".repeat(43))).toBe(false);
    const first = store.issueDeployKey();
    const second = store.issueDeployKey();
    expect(store.deployKeyMatches(first)).toBe(false);
    expect(store.deployKeyMatches(second)).toBe(true);
    // A deploy key is not a device credential.
    expect(store.authenticated(second)).toBe(false);
    expect(store.revokeDeployKey()).toBe(true);
    expect(store.deployKeyMatches(second)).toBe(false);
    store.close();
  });
});
