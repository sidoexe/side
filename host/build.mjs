import { build } from "esbuild";
import { copyFile } from "node:fs/promises";

await build({
  entryPoints: ["host/cli.ts"],
  outfile: "build/host/side-host.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  loader: { ".ps1": "text", ".txt": "text" },
  define: { "import.meta.hot": "undefined" },
  sourcemap: true,
});
await copyFile("host/provider-guard.mjs", "build/host/provider-guard.mjs");
