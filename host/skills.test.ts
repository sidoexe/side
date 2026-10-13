import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { listHostSkills, parseFrontmatter } from "./skills";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function temp(label: string) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), `side-skills-${label}-`)));
  dirs.push(dir);
  return dir;
}

function skill(root: string, folder: string, body: string) {
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, folder, "SKILL.md"), body);
  return join(root, folder, "SKILL.md");
}

it("reads a name and a folded description", () => {
  expect(
    parseFrontmatter(
      "---\nname: review-pr\ndescription: >\n  Review pull requests.\n  Use when asked.\n---\n# hi\n",
      "fallback",
    ),
  ).toEqual({ name: "review-pr", description: "Review pull requests. Use when asked." });
  expect(parseFrontmatter("# no yaml\n", "create-skill")).toEqual({
    name: "create-skill",
    description: "",
  });
});

it("lets .agents skills win over provider folders, project over user", async () => {
  const project = temp("project");
  const home = temp("home");
  const agents = skill(join(project, ".agents/skills"), "ship", "---\nname: ship\ndescription: agents\n---\n");
  skill(join(project, ".claude/skills"), "ship", "---\nname: ship\ndescription: claude\n---\n");
  const user = skill(join(home, ".claude/skills"), "Release Notes", "---\ndescription: 'notes'\n---\n");
  skill(join(home, ".claude/skills"), ".hidden", "---\nname: hidden\n---\n");

  const skills = await listHostSkills(project, { home });
  expect(skills).toEqual([
    { name: "release-notes", description: "notes", path: user, scope: "user", source: "claude" },
    { name: "ship", description: "agents", path: agents, scope: "project", source: "agents" },
  ]);
});

it("drops disabled paths so a lower root can take the name", async () => {
  const project = temp("project");
  const home = temp("home");
  const agents = skill(join(project, ".agents/skills"), "ship", "---\nname: ship\n---\n");
  const claude = skill(join(home, ".claude/skills"), "ship", "---\nname: ship\n---\n");
  const skills = await listHostSkills(project, { home, disabledPaths: [agents] });
  expect(skills.map((entry) => entry.path)).toEqual([claude]);
});

it("namespaces enabled Claude plugin skills", async () => {
  const project = temp("project");
  const home = temp("home");
  const install = join(home, "plugins/review");
  skill(join(install, "skills"), "check", "---\nname: check\n---\n");
  mkdirSync(join(home, ".claude/plugins"), { recursive: true });
  writeFileSync(
    join(home, ".claude/plugins/installed_plugins.json"),
    JSON.stringify({ plugins: { "review@market": [{ installPath: install, scope: "user" }] } }),
  );
  expect((await listHostSkills(project, { home })).map((entry) => entry.name)).toEqual([
    "review:check",
  ]);
  writeFileSync(
    join(home, ".claude/settings.json"),
    JSON.stringify({ enabledPlugins: { "review@market": false } }),
  );
  expect(await listHostSkills(project, { home })).toEqual([]);
});
