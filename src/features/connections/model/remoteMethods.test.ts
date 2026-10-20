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

// A host method the desktop calls but its Rust bridge does not list fails
// silently: a method missing from the list never reached the host.
it("lets the desktop's bridge pass every host method the app calls", () => {
  const rust = readFileSync(join(root, "src-tauri/src/remote.rs"), "utf8");
  const listed = rust.slice(rust.indexOf("fn supported_remote_method"));
  const allowed = new Set(
    [...listed.slice(0, listed.indexOf("\n}\n")).matchAll(/"([a-zA-Z]+\.[a-zA-Z]+)"/g)].map(
      (match) => match[1],
    ),
  );
  const called = new Set<string>();
  for (const file of sources(join(root, "src"))) {
    const text = readFileSync(file, "utf8");
    // The method is the argument after the machine: `remoteRequest(id, "x.y"`
    // or a wrapper's `request(home, "x.y"`.
    for (const match of text.matchAll(
      /\b(?:remoteRequest|request)\s*(?:<[^>]*>)?\(\s*[\w.]+\s*,\s*"([a-zA-Z]+\.[a-zA-Z]+)"/g,
    ))
      called.add(match[1]);
  }
  expect(called.size).toBeGreaterThan(20);
  expect([...called].filter((method) => !allowed.has(method)).sort()).toEqual([]);
});
