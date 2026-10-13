import { isMonoSession } from "../../monos/model/mono";
import type { Session } from "../../sessions/model/session";
import type { SessionSummary } from "../../sessions/data/sessionStore";
import { isRemoteProjectPath, looksLikeProject } from "../../projects/model/recents";
import type { HostProject, RemoteMachine } from "./protocol";
import { remoteRequest } from "./connections";
import { rememberRemoteProject, remoteProjectKey } from "./remoteProjects";

/**
 * sIDE keeps every conversation in one host database. The home machine is the
 * host that owns them: projects open on it, and sessions a desktop recorded
 * locally before are imported into it. `null` turns host-only mode off.
 */
const KEY = "side.homeMachine.v1";
const MIGRATED_KEY = "side.homeMigration.v1";
export const HOME_MACHINE_CHANGED = "side:home-machine-changed";
export const MIGRATION_REPORT_CHANGED = "side:home-migration-report";

type Stored = { environmentId: string } | { disabled: true };

function read(): Stored | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (value && typeof value === "object") {
      if ((value as { disabled?: unknown }).disabled === true) return { disabled: true };
      const id = (value as { environmentId?: unknown }).environmentId;
      if (typeof id === "string" && id) return { environmentId: id };
    }
  } catch {
    /* fall back to the automatic choice */
  }
  return undefined;
}

/** The chosen environment, `null` when host-only mode is off, `undefined`
 * when nothing was chosen and the single connected machine is used. */
export function homeMachineChoice(): string | null | undefined {
  const stored = read();
  if (!stored) return undefined;
  return "disabled" in stored ? null : stored.environmentId;
}

/** An environment id, `null` for off, `undefined` for the automatic choice. */
export function setHomeMachine(environmentId: string | null | undefined): void {
  try {
    if (environmentId === undefined) localStorage.removeItem(KEY);
    else
      localStorage.setItem(
        KEY,
        JSON.stringify(environmentId ? { environmentId } : { disabled: true }),
      );
  } catch {
    /* the choice lasts for this run */
  }
  window.dispatchEvent(new Event(HOME_MACHINE_CHANGED));
}

/** The machine every project and session belongs to. With no explicit
 * choice, a desktop connected to exactly one machine uses that one. */
export function resolveHomeMachine(
  machines: readonly RemoteMachine[],
): RemoteMachine | undefined {
  const choice = homeMachineChoice();
  if (choice === null) return undefined;
  if (choice) return machines.find((machine) => machine.environmentId === choice);
  return machines.length === 1 ? machines[0] : undefined;
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i;

/** A host reached on this very computer (an SSH alias to localhost), whose
 * folders are the ones the native folder picker shows. A plain loopback URL
 * may be a tunnel to another machine, so only SSH targets count. */
export function isLoopbackMachine(machine: Pick<RemoteMachine, "ssh">): boolean {
  const target = machine.ssh?.target;
  if (!target) return false;
  const host = target.slice(target.lastIndexOf("@") + 1).replace(/:\d+$/, "");
  return LOOPBACK.test(host);
}

function readMigrated(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(MIGRATED_KEY) ?? "{}");
    return value && typeof value === "object" ? (value as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Local project path → where it went: a `remote://` key, or `archived`
 * when the home machine has no such folder. Kept so a project is never
 * migrated twice, and so the old local history stays traceable. */
export function migratedProjects(): Record<string, string> {
  return readMigrated();
}

export function recordMigratedProject(path: string, target: string): void {
  try {
    localStorage.setItem(
      MIGRATED_KEY,
      JSON.stringify({ ...readMigrated(), [path]: target }),
    );
  } catch {
    /* retried next launch; the import itself is idempotent */
  }
}

const REPORT_KEY = "side.homeMigrationReport.v1";

export type MigrationReport = {
  at: number;
  imported?: number;
  skipped?: number;
  failed?: string[];
  archived?: boolean;
  error?: string;
};

/** What happened to each moved project, shown in Settings → Connections. */
export function loadMigrationReport(): Record<string, MigrationReport> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(REPORT_KEY) ?? "{}");
    return value && typeof value === "object"
      ? (value as Record<string, MigrationReport>)
      : {};
  } catch {
    return {};
  }
}

export function saveMigrationReport(
  path: string,
  report: Omit<MigrationReport, "at">,
): void {
  try {
    localStorage.setItem(
      REPORT_KEY,
      JSON.stringify({ ...loadMigrationReport(), [path]: { ...report, at: Date.now() } }),
    );
  } catch {
    /* informational only */
  }
  window.dispatchEvent(new Event(MIGRATION_REPORT_CHANGED));
}

/** Local rail projects that still have to move to the home machine. */
export function projectsToMigrate(paths: readonly string[]): string[] {
  const done = readMigrated();
  const seen = new Set<string>();
  return paths.filter((path) => {
    if (isRemoteProjectPath(path) || !looksLikeProject(path) || done[path]) return false;
    if (seen.has(path)) return false;
    seen.add(path);
    return true;
  });
}

/** Open tabs of a project that just moved: each becomes a host tab in place.
 * A tab holding a saved chat now shows the imported copy (same id); a blank
 * one simply opens on the host. `remote` lists the shells to map to a host
 * session, `blocked` is true while one of them is still running locally. */
export function retargetOpenSessions(
  sessions: readonly Session[],
  path: string,
  key: string,
  blank: (cwd: string) => Session,
): { sessions: Session[]; remote: string[]; blocked: boolean } {
  const remote: string[] = [];
  let blocked = false;
  const next = sessions.map((session) => {
    if (session.cwd !== path || isMonoSession(session.id) || session.ephemeral) return session;
    if (session.busy) blocked = true;
    const saved = session.blocks.some((block) => block.role === "user");
    if (saved) remote.push(session.id);
    return { ...blank(key), id: session.id, runtimeMode: session.runtimeMode };
  });
  return { sessions: next, remote, blocked };
}

export type HomeMigrationDeps = {
  openProject: (cwd: string) => Promise<HostProject>;
  importSession: (params: {
    projectId: string;
    session: Session;
    createdAt: number;
    updatedAt: number;
    archived?: boolean;
    pinned?: boolean;
  }) => Promise<{ imported: boolean }>;
  listSessions: (cwd: string) => Promise<SessionSummary[]>;
  getSession: (id: string) => Promise<Session | null>;
};

export type HomeMigrationResult =
  | { kind: "moved"; project: HostProject; key: string; imported: number; skipped: number; failed: string[] }
  | { kind: "missing"; error: string };

/** Opens a local project on the home machine and copies its saved sessions
 * there. Monos stay with the desktop: they are not project conversations. */
export async function migrateProjectToHome(
  machine: Pick<RemoteMachine, "environmentId">,
  path: string,
  deps: HomeMigrationDeps,
): Promise<HomeMigrationResult> {
  let project: HostProject;
  try {
    project = await deps.openProject(path);
  } catch (reason) {
    return { kind: "missing", error: String(reason).replace(/^Error: /, "") };
  }
  let imported = 0;
  let skipped = 0;
  const failed: string[] = [];
  for (const summary of await deps.listSessions(path)) {
    if (isMonoSession(summary.id) || summary.draft) continue;
    try {
      const session = await deps.getSession(summary.id);
      if (!session || !session.blocks.some((block) => block.role === "user")) continue;
      const result = await deps.importSession({
        projectId: project.id,
        session,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
        archived: summary.archived,
        pinned: summary.pinned,
      });
      if (result.imported) imported++;
      else skipped++;
    } catch {
      failed.push(summary.id);
    }
  }
  return {
    kind: "moved",
    project,
    key: remoteProjectKey(machine.environmentId, project.cwd),
    imported,
    skipped,
    failed,
  };
}

/** Opens folders of this computer as projects of the home machine. Returns
 * their rail keys; a folder the host cannot open is reported, not opened. */
export async function openOnHomeMachine(
  machine: RemoteMachine,
  paths: readonly string[],
  open: (cwd: string) => Promise<HostProject> = (cwd) =>
    remoteRequest<HostProject>(machine.id, "projects.open", { cwd }),
): Promise<{ keys: string[]; failed: string[] }> {
  const keys: string[] = [];
  const failed: string[] = [];
  for (const path of paths) {
    try {
      keys.push(rememberRemoteProject(machine.environmentId, await open(path)).key);
    } catch {
      failed.push(path);
    }
  }
  return { keys, failed };
}
