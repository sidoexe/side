import { loadRemoteMachines, remoteRequest } from "./connections";
import { resolveHomeMachine } from "./homeMachine";
import type { HostDescriptor, RemoteMachine } from "./protocol";

const described = new Map<string, Promise<string[]>>();

/** What a connected machine's host advertises, asked once per run. */
export function machineCapabilities(machine: RemoteMachine): Promise<string[]> {
  let capabilities = described.get(machine.id);
  if (!capabilities) {
    capabilities = remoteRequest<HostDescriptor>(machine.id, "environment.describe").then(
      (descriptor) => descriptor.capabilities ?? [],
    );
    described.set(machine.id, capabilities);
    // Asked again next time rather than written off.
    capabilities.catch(() => described.delete(machine.id));
  }
  return capabilities;
}

/** The home machine, when its host advertises `capability`. An unreachable
 * host rejects rather than reading as absent, so callers never fall back to
 * this computer's own copy while the shared one is merely out of reach. */
export async function homeWith(capability: string): Promise<RemoteMachine | undefined> {
  const home = resolveHomeMachine(await loadRemoteMachines());
  if (!home) return undefined;
  return (await machineCapabilities(home)).includes(capability) ? home : undefined;
}
