import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

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

// The browser app the host serves at /web.
await mkdir("build/host/web", { recursive: true });
await build({
  entryPoints: { app: "host/webapp/main.tsx" },
  outdir: "build/host/web",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".woff": "empty", ".woff2": "empty", ".ttf": "empty" },
});
for (const file of ["index.html", "manifest.webmanifest"])
  await copyFile(`host/webapp/${file}`, `build/host/web/${file}`);
await copyFile("public/side.png", "build/host/web/side.png");
