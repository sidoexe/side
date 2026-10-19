import { projectKey, projectName } from "../../../shared/lib/paths";
import {
  loadTabGroupColors,
  loadTabGroupCustomColors,
  loadTabGroupLabels,
  loadTabGroupMascots,
  resolveTabGroupColor,
  resolveTabGroupLabel,
  resolveTabGroupMascot,
  TAB_GROUP_COLORS,
} from "../../workspace/model/tabGroups";
import {
  hasPendingApproval,
  type Block,
  type Session,
} from "../../sessions/model/session";
import {
  PROJECT_MASCOTS,
  projectMascot,
} from "../../projects/model/projectMascots";
import { removeMonoBackground } from "./monoBackground";

/** The project palette's colors, plus indigo for a Mono's ninth preset. */
export const MONO_COLORS = [
  ...TAB_GROUP_COLORS.slice(1),
  "hsl(245 75% 65%)",
] as const;

/**
 * A Mono is a long-lived agent of its own: a name, a mascot and a color, one
 * conversation, and the projects it works on. It is not tied to any one of
 * them; it lives on the rail beside the projects and can be given more.
 */
/** A face picked instead of the mascot: an emoji, or an icon by name. */
export type MonoAvatar =
  | { kind: "emoji"; value: string }
  | { kind: "icon"; value: string };

/** When a Mono may start sessions of its own to hand work to. */
export type MonoDelegation = "never" | "ask" | "free";

export const MONO_DELEGATIONS: { id: MonoDelegation; label: string; description: string }[] = [
  { id: "never", label: "Never", description: "Does the work itself in this chat." },
  { id: "ask", label: "When asked", description: "Starts a session only when you ask for one." },
  { id: "free", label: "As it sees fit", description: "Hands long or parallel work to sessions of its own." },
];

export function monoDelegation(mono: Pick<Mono, "delegation">): MonoDelegation {
  return mono.delegation ?? "never";
}

/** One of a Mono's conversations, each on a topic of its own. */
export type MonoThread = {
  /** The conversation's session id. */
  id: string;
  /** Set from its first message, or by the user. */
  title?: string;
  createdAt: number;
};

export type Mono = {
  id: string;
  /** The conversation open now; absent until it is first opened. */
  sessionId?: string;
  /** Every conversation it has, the open one too. They share its soul,
   * memory and habits; each keeps its own context. */
  threads?: MonoThread[];
  /** Replaces the mascot's own name. */
  name?: string;
  mascot: string;
  color: string;
  /** Replaces the mascot when set. */
  avatar?: MonoAvatar;
  /** Project folders it works on, in the order they were added. */
  projects: string[];
  /** New sessions stay out of the project sidebar unless turned on. */
  showStartedSessionsInSidebar?: boolean;
  /** Files the sessions it starts into a sidebar folder named after it. */
  useSidebarFolders?: boolean;
  /** Kept on this computer only, even when a home machine keeps the others
   * (see `employeeStorage.ts`): left out of the shared roster, its files and
   * conversation stay in this computer's data folder. */
  localOnly?: boolean;
  /** Runs on whichever account has the most weekly room, and moves to the
   * next one, conversation and all, when a limit stops it. */
  balancedAccounts?: boolean;
  /** Whether it starts sessions of its own: only when asked (`ask`), as it
   * sees fit (`free`), or never when absent. */
  delegation?: Exclude<MonoDelegation, "never">;
  /** Superseded by SOUL.md; only read once, to seed it. */
  instructions?: string;
  /**
   * From when each project had its own Mono: the project whose agent folder
   * it inherits. The folder moves under its id the first time it is read.
   */
  legacyProject?: string;
};

const ROSTER_KEY = "monocode:mono-roster";
const MONOS_CHANGED = "monocode:monos-changed";
export const HANDED_KEY = "monocode:mono-handed";

/** Storage from when each project had one Mono, keyed by project. */
const LEGACY_AGENTS_KEY = "monocode:monos";
const LEGACY_PROFILES_KEY = "monocode:mono-profiles";
/** And from before Monos had their name. */
const LEGACY_KEYS: [string, string][] = [
  ["monocode:project-agents", LEGACY_AGENTS_KEY],
  ["monocode:project-agent-profiles", LEGACY_PROFILES_KEY],
  ["monocode:project-agent-handed", HANDED_KEY],
];

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

let migrated = false;

/**
 * Turns each project's Mono into one of its own that works on that project,
 * keeping its conversation, name and look. One never claimed is dropped.
 */
export function migrateLegacyMonoStorage(): void {
  if (migrated) return;
  migrated = true;
  try {
    for (const [legacy, key] of LEGACY_KEYS) {
      const value = localStorage.getItem(legacy);
      if (value == null) continue;
      if (localStorage.getItem(key) == null) localStorage.setItem(key, value);
      localStorage.removeItem?.(legacy);
    }
    if (localStorage.getItem(ROSTER_KEY) != null) return;
    const agents = record(readJson(LEGACY_AGENTS_KEY));
    const profiles = record(readJson(LEGACY_PROFILES_KEY));
    const mascots = loadTabGroupMascots();
    const colors = loadTabGroupColors();
    const customColors = loadTabGroupCustomColors();
    const roster: Mono[] = [];
    for (const project of new Set([
      ...Object.keys(agents),
      ...Object.keys(profiles),
    ])) {
      const sessionId = agents[project];
      const profile = record(profiles[project]);
      if (typeof sessionId !== "string" && profile.claim !== "claimed")
        continue;
      const seed = projectName(project);
      roster.push({
        id: newMonoId(),
        ...(typeof sessionId === "string" ? { sessionId } : {}),
        ...(typeof profile.name === "string" && profile.name.trim()
          ? { name: profile.name }
          : {}),
        mascot: projectMascot(seed, resolveTabGroupMascot(project, mascots))
          .name,
        color: resolveTabGroupColor(project, colors, customColors, seed),
        projects: [project],
        ...(typeof profile.instructions === "string" &&
        profile.instructions.trim()
          ? { instructions: profile.instructions }
          : {}),
        legacyProject: project,
      });
    }
    localStorage.setItem(ROSTER_KEY, JSON.stringify(roster));
    localStorage.removeItem?.(LEGACY_AGENTS_KEY);
    localStorage.removeItem?.(LEGACY_PROFILES_KEY);
  } catch {
    // Storage unavailable: there is nothing to move either.
  }
}

function newMonoId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseMono(value: unknown): Mono | undefined {
  const entry = record(value);
  if (typeof entry.id !== "string" || !/^[A-Za-z0-9-]+$/.test(entry.id))
    return undefined;
  const text = (key: string) =>
    typeof entry[key] === "string" ? (entry[key] as string) : undefined;
  const sessionId = text("sessionId");
  const name = text("name");
  const instructions = text("instructions");
  const legacyProject = text("legacyProject");
  const avatar = parseAvatar(entry.avatar);
  return {
    id: entry.id,
    ...(sessionId ? { sessionId } : {}),
    ...(name ? { name } : {}),
    mascot: text("mascot") ?? PROJECT_MASCOTS[0].name,
    color: text("color") ?? TAB_GROUP_COLORS[1],
    ...(avatar ? { avatar } : {}),
    projects: Array.isArray(entry.projects)
      ? entry.projects.filter(
          (path): path is string => typeof path === "string" && !!path,
        )
      : [],
    ...(typeof entry.showStartedSessionsInSidebar === "boolean"
      ? { showStartedSessionsInSidebar: entry.showStartedSessionsInSidebar }
      : {}),
    ...(entry.useSidebarFolders === true ? { useSidebarFolders: true } : {}),
    ...(entry.localOnly === true ? { localOnly: true } : {}),
    ...(entry.balancedAccounts === true ? { balancedAccounts: true } : {}),
    ...(entry.delegation === "ask" || entry.delegation === "free"
      ? { delegation: entry.delegation }
      : {}),
    ...(parseThreads(entry.threads, sessionId)),
    ...(instructions ? { instructions } : {}),
    ...(legacyProject ? { legacyProject } : {}),
  };
}

function parseThreads(value: unknown, sessionId: string | undefined): { threads?: MonoThread[] } {
  if (!Array.isArray(value)) return {};
  const seen = new Set<string>();
  const threads = value.flatMap((item): MonoThread[] => {
    const entry = record(item);
    if (typeof entry.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.id)) return [];
    if (seen.has(entry.id)) return [];
    seen.add(entry.id);
    const title = typeof entry.title === "string" ? entry.title.trim().slice(0, 120) : "";
    return [
      {
        id: entry.id,
        ...(title ? { title } : {}),
        createdAt: typeof entry.createdAt === "number" ? entry.createdAt : 0,
      },
    ];
  });
  if (sessionId && !seen.has(sessionId)) threads.push({ id: sessionId, createdAt: 0 });
  return threads.length ? { threads } : {};
}

/** A Mono's conversations, newest first; one that predates threads is its only one. */
export function monoThreads(mono: Pick<Mono, "sessionId" | "threads">): MonoThread[] {
  const threads = mono.threads?.length
    ? mono.threads
    : mono.sessionId
      ? [{ id: mono.sessionId, createdAt: 0 }]
      : [];
  return [...threads].sort((a, b) => b.createdAt - a.createdAt);
}

function parseAvatar(value: unknown): MonoAvatar | undefined {
  const entry = record(value);
  if (typeof entry.value !== "string") return undefined;
  if (entry.kind === "emoji" && entry.value && [...entry.value].length <= 16)
    return { kind: "emoji", value: entry.value };
  if (entry.kind === "icon" && /^[A-Za-z0-9]{1,64}$/.test(entry.value))
    return { kind: "icon", value: entry.value };
  return undefined;
}

/** Every Mono, in the order the rail shows them. */
export function listMonos(): Mono[] {
  migrateLegacyMonoStorage();
  const parsed = readJson(ROSTER_KEY);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => parseMono(entry) ?? []);
}

function saveRoster(roster: readonly Mono[]): void {
  try {
    localStorage.setItem(ROSTER_KEY, JSON.stringify(roster));
  } catch {
    return;
  }
  window.dispatchEvent(new CustomEvent(MONOS_CHANGED));
}

export function findMono(id: string): Mono | undefined {
  return listMonos().find((mono) => mono.id === id);
}

/** The Mono whose conversation this is. */
/** The Mono a conversation belongs to, whichever of its threads it is. */
export function monoForSession(sessionId: string): Mono | undefined {
  return listMonos().find(
    (mono) =>
      mono.sessionId === sessionId ||
      !!mono.threads?.some((thread) => thread.id === sessionId),
  );
}

export function isMonoSession(sessionId: string): boolean {
  return !!monoForSession(sessionId);
}

/**
 * The mascot and color the next Mono gets: ones the others are not using yet,
 * where any are left.
 */
export function nextMonoLook(
  roster: readonly Pick<Mono, "mascot" | "color">[] = listMonos(),
): { mascot: string; color: string } {
  const mascots = new Set(roster.map((mono) => mono.mascot));
  const colors = new Set(roster.map((mono) => mono.color));
  const palette = MONO_COLORS;
  return {
    mascot: (
      PROJECT_MASCOTS.find((mascot) => !mascots.has(mascot.name)) ??
      PROJECT_MASCOTS[roster.length % PROJECT_MASCOTS.length]
    ).name,
    color:
      palette.find((color) => !colors.has(color)) ??
      palette[roster.length % palette.length],
  };
}

/** A new Mono with the next look, starting with the projects given, if any. */
export function createMono(projects: readonly string[] = []): Mono {
  const roster = listMonos();
  const mono: Mono = {
    id: newMonoId(),
    ...nextMonoLook(roster),
    projects: uniqueProjects(projects),
  };
  saveRoster([...roster, mono]);
  return mono;
}

const OPEN_MONO_KEY = "monocode:open-mono";

/** The Mono whose conversation was open, so the next launch reopens it. */
export function loadOpenMono(): string | undefined {
  try {
    return localStorage.getItem(OPEN_MONO_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveOpenMono(monoId: string | undefined): void {
  try {
    if (monoId) localStorage.setItem(OPEN_MONO_KEY, monoId);
    else localStorage.removeItem(OPEN_MONO_KEY);
  } catch {
    // The next launch opens the workspace instead; harmless.
  }
}

function uniqueProjects(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((path) => {
    const key = projectKey(path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function updateMono(
  id: string,
  change: (mono: Mono) => Mono,
): Mono | undefined {
  const roster = listMonos();
  const index = roster.findIndex((mono) => mono.id === id);
  if (index < 0) return undefined;
  const next = change(roster[index]);
  if (!next.name?.trim()) delete next.name;
  if (!next.instructions?.trim()) delete next.instructions;
  next.projects = uniqueProjects(next.projects);
  roster[index] = next;
  saveRoster(roster);
  return next;
}

/** Takes a roster read from the home machine as this window's own. */
export function replaceRoster(roster: readonly unknown[]): void {
  saveRoster(roster.flatMap((entry) => parseMono(entry) ?? []));
}

/** Forgets the Mono and its background. Its folder of files stays on disk. */
export function removeMono(id: string): void {
  removeMonoBackground(id);
  saveRoster(listMonos().filter((mono) => mono.id !== id));
}

export function reorderMonos(ids: readonly string[]): void {
  const roster = listMonos();
  const order = new Map(ids.map((id, index) => [id, index]));
  saveRoster(
    [...roster].sort(
      (a, b) =>
        (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    ),
  );
}

/** Opens a conversation as the Mono's current one, adding it to its threads. */
export function saveMonoSessionId(monoId: string, sessionId: string): void {
  updateMono(monoId, (mono) => {
    const threads = monoThreads(mono);
    return {
      ...mono,
      sessionId,
      threads: threads.some((thread) => thread.id === sessionId)
        ? threads
        : [{ id: sessionId, createdAt: Date.now() }, ...threads],
    };
  });
}

/** Leaves the open conversation in its threads; the next open starts a new one. */
export function startMonoThread(monoId: string): void {
  updateMono(monoId, ({ sessionId: _open, ...mono }) => ({
    ...mono,
    threads: monoThreads({ ...mono, sessionId: _open }),
  }));
}

/** Opens one of the Mono's own threads; false for any other session. */
export function switchMonoThread(monoId: string, threadId: string): boolean {
  const mono = findMono(monoId);
  if (!mono || !monoThreads(mono).some((thread) => thread.id === threadId)) return false;
  updateMono(monoId, (current) => ({
    ...current,
    sessionId: threadId,
    threads: monoThreads(current),
  }));
  return true;
}

/** A thread's name from the first thing asked in it: its first line, short. */
export function monoThreadTitle(text: string): string {
  const line =
    text
      .split("\n")
      .map((part) => part.replace(/[#*_`>]+/g, "").trim())
      .find(Boolean) ?? "";
  return line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line;
}

export function renameMonoThread(monoId: string, threadId: string, title: string): void {
  const clean = title.trim().slice(0, 120);
  updateMono(monoId, (mono) => ({
    ...mono,
    threads: monoThreads(mono).map((thread) => {
      if (thread.id !== threadId) return thread;
      const { title: _title, ...untitled } = thread;
      return clean ? { ...untitled, title: clean } : untitled;
    }),
  }));
}

/**
 * Drops a thread from the Mono. When it was the open one, the newest other
 * thread opens, or none, and the next open starts a fresh conversation.
 */
export function forgetMonoThread(monoId: string, threadId: string): void {
  updateMono(monoId, (mono) => {
    const threads = monoThreads(mono).filter((thread) => thread.id !== threadId);
    const { sessionId, threads: _old, ...rest } = mono;
    const open = sessionId === threadId ? threads[0]?.id : sessionId;
    return {
      ...rest,
      ...(open ? { sessionId: open } : {}),
      ...(threads.length ? { threads } : {}),
    };
  });
}

export function saveMonoBalanced(monoId: string, balanced: boolean): void {
  updateMono(monoId, ({ balancedAccounts: _balanced, ...mono }) =>
    balanced ? { ...mono, balancedAccounts: true } : mono,
  );
}

export function saveMonoDelegation(
  monoId: string,
  delegation: MonoDelegation,
): void {
  updateMono(monoId, ({ delegation: _delegation, ...mono }) =>
    delegation === "never" ? mono : { ...mono, delegation },
  );
}

export function saveMonoName(monoId: string, name: string): void {
  updateMono(monoId, (mono) => ({ ...mono, name }));
}

/** Picking a mascot puts it back in place of any emoji or icon. */
export function saveMonoMascot(monoId: string, mascot: string): void {
  updateMono(monoId, ({ avatar: _avatar, ...mono }) => ({ ...mono, mascot }));
}

export function saveMonoAvatar(monoId: string, avatar: MonoAvatar): void {
  updateMono(monoId, (mono) => ({ ...mono, avatar }));
}

export function addMonoProject(monoId: string, path: string): void {
  updateMono(monoId, (mono) => ({
    ...mono,
    projects: [...mono.projects, path],
  }));
}

export function removeMonoProject(monoId: string, path: string): void {
  const key = projectKey(path);
  updateMono(monoId, (mono) => ({
    ...mono,
    projects: mono.projects.filter((project) => projectKey(project) !== key),
  }));
}

/** Whether the Mono has been given this project. */
export function monoWorksOn(mono: Pick<Mono, "projects">, path: string) {
  const key = projectKey(path);
  return mono.projects.some((project) => projectKey(project) === key);
}

export function subscribeMonos(onChange: () => void): () => void {
  window.addEventListener(MONOS_CHANGED, onChange);
  return () => window.removeEventListener(MONOS_CHANGED, onChange);
}

/**
 * Snapshot for `useSyncExternalStore`; stable while storage is unchanged.
 * Project labels are part of it, since a Mono's look names its projects.
 */
export function monosSnapshot(): string {
  migrateLegacyMonoStorage();
  try {
    return `${localStorage.getItem(ROSTER_KEY) ?? ""}|${JSON.stringify(
      loadTabGroupLabels(),
    )}`;
  } catch {
    return "";
  }
}

/** Mascots whose Mono name is shorter than the mascot's. */
const MONO_NAME: Record<string, string> = { mushroom: "Shroom" };

/** The name a Mono goes by until the user names it: "MonoCrab", "MonoShroom". */
export function defaultMonoName(mascot: string): string {
  return `Mono${MONO_NAME[mascot] ?? mascot.charAt(0).toUpperCase() + mascot.slice(1)}`;
}

/** One project a Mono works on, as the rail labels it. */
export type MonoProject = { path: string; name: string };

export type MonoLook = {
  /** The user's name for it, or its default: "MonoInvader", "MonoGhost". */
  name: string;
  mascot: string;
  color: string;
  avatar?: MonoAvatar;
  /** Absent: it never starts sessions of its own. */
  delegation?: Exclude<MonoDelegation, "never">;
  projects: MonoProject[];
};

/** How a Mono looks, and the projects it works on by their rail labels. */
export function monoLook(mono: Mono): MonoLook {
  const labels = loadTabGroupLabels();
  return {
    name: mono.name?.trim() || defaultMonoName(mono.mascot),
    mascot: mono.mascot,
    color: mono.color,
    ...(mono.avatar ? { avatar: mono.avatar } : {}),
    ...(mono.delegation ? { delegation: mono.delegation } : {}),
    projects: mono.projects.map((path) => ({
      path,
      name: resolveTabGroupLabel(projectKey(path), labels, projectName(path)),
    })),
  };
}

/** Its projects as a phrase: "app", "app and site", "app, site and api". */
export function monoProjectsPhrase(projects: readonly MonoProject[]): string {
  const names = projects.map((project) => project.name);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Plain one-line take on a step's title, for the Mono's status. */
function plainLine(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:#{1,6}|>)\s*/gm, "")
    .replace(/[`*_]/g, "")
    .replace(/^\s*[-\d.]+\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** What the agent is doing right now, as the Monos roster shows it. */
export type MonoStatus = "working" | "needs-you" | "idle";

export type MonoState = {
  status: MonoStatus;
  /** Short present-tense note while working or waiting. */
  activity?: string;
};

export const MONO_STATUS_LABEL: Record<MonoStatus, string> = {
  working: "Working",
  "needs-you": "Needs you",
  idle: "Idle",
};

/** The agent's state, with the step it is on or the call it is waiting for. */
export function monoState(
  session: Pick<
    Session,
    "blocks" | "busy" | "pendingQuestion" | "worktreeRemoved" | "usageLimit"
  >,
): MonoState {
  const { blocks, pendingQuestion: question } = session;
  if (!session.worktreeRemoved && question) {
    return {
      status: "needs-you",
      activity: question.title?.trim() || question.questions[0]?.prompt.trim(),
    };
  }
  if (!session.worktreeRemoved && hasPendingApproval(blocks)) {
    const approval = latest(
      blocks,
      (block) => !!block.approval && !block.approval.decided,
    );
    return {
      status: "needs-you",
      activity: approval?.tool?.title
        ? `Approve ${plainLine(approval.tool.title)}`
        : "Waiting for approval",
    };
  }
  if (!session.worktreeRemoved && session.usageLimit) {
    return { status: "needs-you", activity: "Usage limit reached" };
  }
  if (!session.busy) return { status: "idle" };
  const last = blocks[blocks.length - 1];
  if (last?.role === "assistant" && !last.tool && last.streaming) {
    return { status: "working", activity: "Writing a reply" };
  }
  // Only a step from the current turn says what it is doing now.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.role === "user") break;
    if (block.tool?.title) {
      return { status: "working", activity: plainLine(block.tool.title) };
    }
  }
  return { status: "working", activity: "Thinking" };
}

function latest(
  blocks: readonly Block[],
  match: (block: Block) => boolean,
): Block | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (match(blocks[i])) return blocks[i];
  }
  return undefined;
}
