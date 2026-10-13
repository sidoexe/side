import { remoteRequest } from "../../connections/model/connections";
import type { RemoteMachine } from "../../connections/model/protocol";
import { listMonos, replaceRoster, subscribeMonos, type Mono } from "./mono";
import { employeeHome } from "./employeeStorage";

/**
 * Keeps this desktop's roster and the home machine's in step, so every
 * desktop lists the same employees with the same look and projects. The host
 * keeps a revision; a push over a stale one is refused, and the two rosters
 * are then merged against the last one both sides agreed on.
 */

type HostRoster = { revision: number; roster: unknown[] };

const POLL_MS = 15_000;

function entryId(entry: unknown): string | undefined {
  const id = (entry as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : undefined;
}

/**
 * Three-way merge by employee: whatever this desktop changed since `base`
 * wins, everything else comes from `remote`, including employees another
 * desktop added or removed. The host's order is kept; new local ones go last.
 */
export function mergeRosters(
  base: readonly unknown[],
  local: readonly unknown[],
  remote: readonly unknown[],
): unknown[] {
  const byId = (list: readonly unknown[]) =>
    new Map(list.flatMap((entry) => (entryId(entry) ? [[entryId(entry)!, entry]] : [])));
  const before = byId(base);
  const mine = byId(local);
  const changed = (id: string) =>
    JSON.stringify(before.get(id)) !== JSON.stringify(mine.get(id));
  const merged: unknown[] = [];
  const seen = new Set<string>();
  for (const entry of remote) {
    const id = entryId(entry);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (!changed(id)) merged.push(entry);
    else if (mine.has(id)) merged.push(mine.get(id));
    // Removed here since `base`: it stays removed.
  }
  for (const entry of local) {
    const id = entryId(entry)!;
    if (seen.has(id) || before.has(id)) continue;
    seen.add(id);
    merged.push(entry);
  }
  return merged;
}

const same = (a: readonly unknown[], b: readonly unknown[]) =>
  JSON.stringify(a) === JSON.stringify(b);

/** One desktop's sync with the home machine's roster. */
export class EmployeeRosterSync {
  private base?: { environmentId: string; revision: number; roster: unknown[] };
  private running?: Promise<void>;
  private again = false;

  constructor(
    private readonly request: <T>(machine: RemoteMachine, method: string, params?: unknown) => Promise<T>,
    private readonly home: () => Promise<RemoteMachine | undefined>,
    private readonly local: () => Mono[] = listMonos,
    private readonly replace: (roster: readonly unknown[]) => void = replaceRoster,
  ) {}

  /** Pulls the host's roster and pushes this desktop's changes; a call made
   * while one runs is folded into one more pass. */
  sync(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  private async pass(): Promise<void> {
    const home = await this.home();
    if (!home) return;
    if (this.base?.environmentId !== home.environmentId) this.base = undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const remote = await this.request<HostRoster>(home, "employees.roster");
      const local = this.local();
      // First contact: the host's employees stay as they are and this
      // desktop's own ones join them, so no desktop's are lost.
      const merged = this.base
        ? mergeRosters(this.base.roster, local, remote.roster)
        : mergeRosters(remote.roster, remote.roster, [...remote.roster, ...local]);
      if (!same(merged, local)) this.replace(merged);
      if (same(merged, remote.roster)) {
        this.base = { environmentId: home.environmentId, ...remote };
        return;
      }
      try {
        const saved = await this.request<HostRoster>(home, "employees.saveRoster", {
          roster: merged,
          expectedRevision: remote.revision,
        });
        this.base = { environmentId: home.environmentId, ...saved };
        return;
      } catch (error) {
        if (!/conflict$/.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
  }
}

/** Runs the sync while the app is open: on start, on every local change,
 * when the window comes back, and every few seconds for other desktops'. */
export function startEmployeeRosterSync(): () => void {
  const sync = new EmployeeRosterSync(
    (machine, method, params) => remoteRequest(machine.id, method, params),
    employeeHome,
  );
  const run = () => void sync.sync().catch(() => undefined);
  run();
  const unsubscribe = subscribeMonos(run);
  const timer = setInterval(run, POLL_MS);
  window.addEventListener("focus", run);
  return () => {
    unsubscribe();
    clearInterval(timer);
    window.removeEventListener("focus", run);
  };
}
