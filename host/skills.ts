import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { DiscoveredSkill } from "../src/platform/tauri/fs";

const MAX_SKILLS = 5_000;
type Scope = DiscoveredSkill["scope"];
type Source = DiscoveredSkill["source"];
const MAX_FRONTMATTER_BYTES = 16 * 1024;

/** The host port of `src-tauri/src/skills.rs`: the skills visible from a
 * project on this machine, `.agents/skills` first, then each provider's
 * folders, then Claude plugins. Same name: earlier roots win. */
export async function listHostSkills(
  project: string,
  options: { home?: string; disabledPaths?: readonly string[] | null } = {},
): Promise<DiscoveredSkill[]> {
  const home = options.home ?? homedir();
  const disabled = new Set(options.disabledPaths ?? []);
  const byName = new Map<string, DiscoveredSkill>();
  const seenRoots = new Set<string>();

  const addRoot = async (
    root: string,
    scope: Scope,
    source: Source,
    namespace?: string,
  ) => {
    if (byName.size >= MAX_SKILLS) return;
    if (!namespace) {
      const key = await realpath(root).catch(() => root);
      if (seenRoots.has(key)) return;
      seenRoots.add(key);
    }
    for (const skill of await scanRoot(root, scope, source)) {
      if (disabled.has(skill.path)) continue;
      if (byName.size >= MAX_SKILLS) break;
      if (namespace) skill.name = `${namespace}:${skill.name}`;
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  };

  await addRoot(join(project, ".agents/skills"), "project", "agents");
  await addRoot(join(home, ".agents/skills"), "user", "agents");
  for (const [dir, source] of [
    [".claude/skills", "claude"],
    [".cursor/skills", "cursor"],
    [".codex/skills", "codex"],
    [".opencode/skills", "opencode"],
    [".pi/skills", "pi"],
    [".omp/skills", "omp"],
    [".fx/skills", "fx"],
    [".grok/skills", "grok"],
    [".hermes/skills", "hermes"],
  ] as const) {
    await addRoot(join(project, dir), "project", source);
    await addRoot(join(home, dir), "user", source);
  }
  await addRoot(join(home, ".pi/agent/skills"), "user", "pi");
  await addRoot(join(home, ".omp/agent/skills"), "user", "omp");
  await addRoot(join(home, ".gemini/antigravity/skills"), "user", "antigravity");
  await addRoot(join(home, ".config/devin/skills"), "user", "devin");
  await addRoot(join(project, ".devin/skills"), "project", "devin");
  for (const plugin of await claudePluginSkillRoots(home, project))
    await addRoot(plugin.root, plugin.scope, "claude", plugin.namespace);

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function scanRoot(
  root: string,
  scope: Scope,
  source: Source,
): Promise<DiscoveredSkill[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const out: DiscoveredSkill[] = [];
  for (const entry of entries) {
    const folder = entry.name;
    if (folder.startsWith(".") || folder === "skills-cursor") continue;
    const dir = join(root, folder);
    const info = await stat(dir).catch(() => undefined);
    if (!info?.isDirectory()) continue;
    const skillMd = await skillMdPath(dir);
    if (!skillMd) continue;
    const text = await readPrefix(skillMd).catch(() => undefined);
    if (text === undefined) continue;
    const fallback = slugName(folder);
    if (!fallback) continue;
    const { name, description } = parseFrontmatter(text, fallback);
    if (!name) continue;
    out.push({ name, description, path: skillMd, scope, source });
  }
  return out;
}

async function skillMdPath(dir: string): Promise<string | undefined> {
  for (const name of ["SKILL.md", "skill.md"]) {
    const path = join(dir, name);
    if ((await stat(path).catch(() => undefined))?.isFile()) return path;
  }
  return undefined;
}

async function readPrefix(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_FRONTMATTER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, bytesRead),
    );
  } finally {
    await handle.close();
  }
}

export function parseFrontmatter(
  text: string,
  fallback: string,
): { name: string; description: string } {
  const trimmed = text.replace(/^\uFEFF+/, "");
  if (!trimmed.startsWith("---")) return { name: fallback, description: "" };
  let rest = trimmed.slice(3);
  if (rest.startsWith("\r")) rest = rest.slice(1);
  if (rest.startsWith("\n")) rest = rest.slice(1);
  const end = rest.indexOf("\n---");
  const yaml = end === -1 ? rest : rest.slice(0, end);

  let name: string | undefined;
  let description = "";
  let inDescription = false;
  let fold = false;
  for (const raw of yaml.split(/\r?\n/)) {
    if (inDescription) {
      if (raw.startsWith(" ") || raw.startsWith("\t")) {
        const piece = raw.trim();
        if (!piece) continue;
        if (description) description += fold ? " " : "\n";
        description += piece;
        continue;
      }
      inDescription = false;
    }
    const line = raw.trimEnd();
    const nameValue = yamlValue(line, "name");
    if (nameValue !== undefined) {
      name = unquote(nameValue);
      continue;
    }
    const value = yamlValue(line, "description");
    if (value === undefined) continue;
    if (value.startsWith(">") || value.startsWith("|")) {
      inDescription = true;
      fold = value.startsWith(">");
      description = "";
    } else {
      description = unquote(value);
    }
  }
  return {
    name: name && isValidSkillName(name) ? name : fallback,
    description: description.trim(),
  };
}

function yamlValue(line: string, key: string): string | undefined {
  const start = line.trimStart();
  return start.startsWith(`${key}:`)
    ? start.slice(key.length + 1).trim()
    : undefined;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  )
    return trimmed.slice(1, -1);
  return trimmed;
}

function isValidSkillName(name: string): boolean {
  return (
    name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
  );
}

function slugName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

type PluginRoot = { root: string; scope: Scope; namespace: string };

async function claudePluginSkillRoots(
  home: string,
  project: string,
): Promise<PluginRoot[]> {
  const registry = await readJson(
    join(home, ".claude/plugins/installed_plugins.json"),
  );
  const plugins = registry?.plugins;
  if (!plugins || typeof plugins !== "object") return [];
  const roots: PluginRoot[] = [];
  for (const [pluginId, installed] of Object.entries(
    plugins as Record<string, unknown>,
  )) {
    if (!(await claudePluginEnabled(home, project, pluginId))) continue;
    const at = pluginId.lastIndexOf("@");
    const namespace = at === -1 ? pluginId : pluginId.slice(0, at);
    if (!isValidSkillName(namespace)) continue;
    const entries = Array.isArray(installed)
      ? installed
      : installed && typeof installed === "object"
        ? [installed]
        : [];
    for (const entry of entries as Array<Record<string, unknown>>) {
      if (typeof entry?.installPath !== "string") continue;
      let scope: Scope;
      if (entry.scope === "project" || entry.scope === "local") {
        if (typeof entry.projectPath !== "string") continue;
        if (!(await pathIsWithin(project, resolveHomePath(entry.projectPath, home))))
          continue;
        scope = "project";
      } else if (entry.scope === "user" || entry.scope === undefined) {
        scope = "user";
      } else continue;
      roots.push({
        root: join(resolveHomePath(entry.installPath, home), "skills"),
        scope,
        namespace,
      });
    }
  }
  return roots.sort(
    (a, b) => (a.scope === "project" ? 0 : 1) - (b.scope === "project" ? 0 : 1),
  );
}

function resolveHomePath(raw: string, home: string): string {
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return join(home, raw.slice(2));
  return isAbsolute(raw) ? raw : join(home, raw);
}

async function claudePluginEnabled(
  home: string,
  project: string,
  pluginId: string,
): Promise<boolean> {
  const managed = await managedPluginSetting(pluginId);
  if (managed !== undefined) return managed;
  const root = await claudeSettingsProjectRoot(project);
  for (const settings of [
    join(root, ".claude/settings.local.json"),
    join(root, ".claude/settings.json"),
    join(home, ".claude/settings.json"),
  ]) {
    const enabled = await pluginSetting(settings, pluginId);
    if (enabled !== undefined) return enabled;
  }
  return true;
}

async function claudeSettingsProjectRoot(project: string): Promise<string> {
  for (let candidate = resolve(project); ; candidate = dirname(candidate)) {
    for (const file of ["settings.local.json", "settings.json"])
      if ((await stat(join(candidate, ".claude", file)).catch(() => undefined))?.isFile())
        return candidate;
    if (dirname(candidate) === candidate) return project;
  }
}

async function pluginSetting(
  path: string,
  pluginId: string,
): Promise<boolean | undefined> {
  const value = (await readJson(path))?.enabledPlugins;
  const enabled =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)[pluginId]
      : undefined;
  return typeof enabled === "boolean" ? enabled : undefined;
}

async function managedPluginSetting(
  pluginId: string,
): Promise<boolean | undefined> {
  const root =
    process.platform === "darwin"
      ? "/Library/Application Support/ClaudeCode"
      : process.platform === "win32"
        ? "C:\\Program Files\\ClaudeCode"
        : "/etc/claude-code";
  let value = await pluginSetting(join(root, "managed-settings.json"), pluginId);
  const dir = join(root, "managed-settings.d");
  const files = (await readdir(dir).catch(() => []))
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .sort();
  for (const file of files) {
    const enabled = await pluginSetting(join(dir, file), pluginId);
    if (enabled !== undefined) value = enabled;
  }
  return value;
}

async function pathIsWithin(path: string, root: string): Promise<boolean> {
  const [actual, base] = await Promise.all([
    realpath(path).catch(() => undefined),
    realpath(root).catch(() => undefined),
  ]);
  if (!actual || !base) return false;
  const rel = relative(base, actual);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
