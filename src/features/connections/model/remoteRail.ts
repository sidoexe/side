import {
  loadArchivedProjects,
  loadProjectRailOrder,
  loadRecents,
  sameProjectPath,
} from "../../projects/model/recents";
import { remoteRequest } from "./connections";
import { machineCapabilities } from "./homeCapability";
import type { RemoteMachine } from "./protocol";
import { parseRemotePath } from "./remoteProjects";

export type MachineRail = { projects: string[]; archived: string[] };

/**
 * The rail as one machine's folders: the projects of `environmentId` this
 * desktop shows, in rail order, and the ones it archived. Its host keeps
 * them, so the browser app shows the same projects as the rail.
 */
export function machineRail(environmentId: string): MachineRail {
  const onMachine = (path: string) => {
    const remote = parseRemotePath(path);
    return remote?.environmentId === environmentId ? remote.hostPath : undefined;
  };
  const order = loadProjectRailOrder();
  const archived = loadArchivedProjects();
  const shown = loadRecents()
    .filter((item) => !archived.some((entry) => sameProjectPath(entry.path, item.path)))
    .map((item) => item.path);
  const rank = (path: string) => {
    const index = order.findIndex((entry) => sameProjectPath(entry, path));
    return index < 0 ? order.length : index;
  };
  const sorted = shown
    .map((path, index) => ({ path, index }))
    .sort((a, b) => rank(a.path) - rank(b.path) || a.index - b.index)
    .map((item) => item.path);
  return {
    projects: sorted.flatMap((path) => onMachine(path) ?? []),
    archived: archived.flatMap((item) => onMachine(item.path) ?? []),
  };
}

const sent = new Map<string, string>();

/** Sends each connected machine its part of the rail when it changed since
 * the last send; a host too old to keep a rail is skipped. */
export async function publishRails(machines: RemoteMachine[]): Promise<void> {
  await Promise.all(
    machines.map(async (machine) => {
      const rail = machineRail(machine.environmentId);
      const text = JSON.stringify(rail);
      if (sent.get(machine.id) === text) return;
      try {
        if (!(await machineCapabilities(machine)).includes("projects.rail")) return;
        await remoteRequest(machine.id, "projects.setRail", rail);
        sent.set(machine.id, text);
      } catch {
        /* sent again on the next change or check */
      }
    }),
  );
}
