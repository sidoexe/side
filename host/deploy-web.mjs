import { cp, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Puts the browser app just built (`npm run host:build`) on an installed
// host, in place of the one its package came with. The host reads these
// files on each request, so the new app is served at once, without a
// restart. The app it replaces stays beside it as `web.previous`.
//   node host/deploy-web.mjs [--data-dir ~/.side-host]
const args = process.argv.slice(2);
const dataDir = resolve(args.includes("--data-dir") ? args[args.indexOf("--data-dir") + 1] : join(homedir(), ".side-host"));
const source = resolve("build/host/web");

let runtime;
try {
  runtime = (await readFile(join(dataDir, "runtime-path"), "utf8")).trim();
} catch {
  console.log(`No host installed in ${dataDir}; nothing to deploy.`);
  process.exit(0);
}
for (const file of ["index.html", "app.js", "app.css", "sw.js", "manifest.webmanifest", "side.png"])
  await stat(join(source, file)).catch(() => {
    throw new Error(`Missing ${file} in build/host/web: run npm run host:build first`);
  });

const target = join(runtime, "web");
const next = join(runtime, "web.next");
const previous = join(runtime, "web.previous");
// Copied next to the live folder first, so the swap is two renames and a
// request never finds it half written.
await rm(next, { recursive: true, force: true });
await cp(source, next, { recursive: true });
await rm(previous, { recursive: true, force: true });
await rename(target, previous).catch((error) => {
  if (error.code !== "ENOENT") throw error;
});
await rename(next, target);

const { version } = JSON.parse(await readFile(join(runtime, "version.json"), "utf8").catch(() => "{}"));
console.log(`Deployed the web app to ${target} (host ${version ?? "?"}); the previous one is in ${previous}.`);
