import { relative, resolve, isAbsolute } from "node:path";
import type { RemoteProvider } from "../src/features/connections/model/protocol";
import type { NativeCommand, NativeCommandProvider } from "../src/integrations/harness/core/nativeCommands";
import { devinCommandProvider } from "../src/integrations/harness/providers/devin/devinAdapter";
import { ompCommandProvider } from "../src/integrations/harness/providers/pi/piFamily";
import { discoverPiSkills } from "../src/integrations/harness/providers/pi/piSkills";
import type { HostStore } from "./store";

/** The agents whose slash commands are their own catalog rather than skill
 * files, as the desktop's adapters list them. */
const NATIVE: Partial<Record<RemoteProvider, NativeCommandProvider>> = {
  pi: { discover: ({ cwd }) => discoverPiSkills(cwd) },
  omp: ompCommandProvider,
  devin: devinCommandProvider,
};

/** A harness's native commands in a folder of one of this host's projects,
 * for the composer's `/` menu; `sessionId` names a running conversation
 * (Devin advertises its commands there). */
export async function listHostCommands(
  store: HostStore,
  harness: unknown,
  cwd: unknown,
  sessionId: unknown,
): Promise<NativeCommand[]> {
  const provider = typeof harness === "string" ? NATIVE[harness as RemoteProvider] : undefined;
  if (!provider) return [];
  if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new Error("Invalid folder");
  const folder = resolve(cwd);
  const inProject = store.projects().some((project) => {
    const inside = relative(resolve(project.cwd), folder);
    return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
  });
  if (!inProject) throw new Error("That folder is not in a project of this host");
  return provider.discover({ cwd: folder, ...(typeof sessionId === "string" ? { sessionId } : {}) });
}
