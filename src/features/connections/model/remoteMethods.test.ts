import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const root = join(__dirname, "../../../..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

// The desktop's native layer forwards only the host methods it lists, and
// tests mock `remote_request`, so a method missing there fails only in the app.
it("lets every host method the desktop calls through the native allowlist", () => {
  const rust = readFileSync(join(root, "src-tauri/src/remote.rs"), "utf8");
  const list = rust.slice(rust.indexOf("fn supported_remote_method"));
  const allowed = new Set(
    [...list.slice(0, list.indexOf("\n}\n")).matchAll(/"([a-zA-Z.]+)"/g)].map((m) => m[1]),
  );
  const called = new Set<string>();
  for (const file of sources(join(root, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/remoteRequest(?:<[^>]*>)?\(\s*[\w.]+,\s*"([a-zA-Z.]+)"/g))
      called.add(match[1]);
  }
  expect(called.size).toBeGreaterThan(10);
  expect([...called].filter((method) => !allowed.has(method))).toEqual([]);
});
