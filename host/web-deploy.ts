import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";

/** Where official releases are published; the only source a deploy installs from. */
export const RELEASES = "https://github.com/sidoexe/side/releases/download";
/** Every release builds this package, and each one carries the same `web`
 * folder, whatever machine this host runs on. */
const PACKAGE = "side-host-darwin-arm64.tar.gz";
const MAX_PACKAGE = 300 * 1024 * 1024;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const DEPLOY_KEY = /^[A-Za-z0-9_-]{43}$/;

export const deployKeyHash = (key: string) => createHash("sha256").update(key).digest("hex");
export const newDeployKey = () => randomBytes(32).toString("base64url");

async function download(fetcher: typeof fetch, url: string): Promise<Buffer> {
  const response = await fetcher(url, { redirect: "follow", signal: AbortSignal.timeout(240_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_PACKAGE) throw new Error(`${url} is too large`);
  return bytes;
}

let running: Promise<unknown> | undefined;

/**
 * Replaces the browser app this host serves with the one of an official
 * release: its host package is read from GitHub and checked against the
 * checksum published beside it, and only its `web` folder is kept. The swap
 * is two renames next to `root`, so a request never finds it half written;
 * the app it replaces stays as `web.previous`. One deploy at a time.
 */
export async function deployWebRelease(
  version: unknown,
  root: string,
  fetcher: typeof fetch = fetch,
): Promise<{ version: string }> {
  if (typeof version !== "string" || !VERSION.test(version)) throw new Error("Invalid release version");
  if (running) throw new Error("A deploy is already running");
  const work = `${root}.deploy-${randomBytes(4).toString("hex")}`;
  const deploy = (async () => {
    const base = `${RELEASES}/v${version}/${PACKAGE}`;
    const [archive, checksum] = await Promise.all([download(fetcher, base), download(fetcher, `${base}.sha256`)]);
    const expected = checksum.toString("utf8").trim().split(/\s+/)[0];
    if (createHash("sha256").update(archive).digest("hex") !== expected)
      throw new Error("The release package does not match its checksum");
    await mkdir(join(work, "package"), { recursive: true, mode: 0o700 });
    await writeFile(join(work, PACKAGE), archive, { mode: 0o600 });
    await promisify(execFile)("tar", ["-xzf", join(work, PACKAGE), "-C", join(work, "package"), "./web", "./version.json"]);
    const packaged = JSON.parse(await readFile(join(work, "package", "version.json"), "utf8")) as { version?: string };
    if (packaged.version !== version) throw new Error(`The package is version ${packaged.version}, not ${version}`);
    await stat(join(work, "package", "web", "index.html"));
    const previous = `${root}.previous`;
    await rm(previous, { recursive: true, force: true });
    await rename(root, previous).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rename(join(work, "package", "web"), root);
    return { version };
  })();
  running = deploy;
  try {
    return await deploy;
  } finally {
    running = undefined;
    await rm(work, { recursive: true, force: true });
  }
}
