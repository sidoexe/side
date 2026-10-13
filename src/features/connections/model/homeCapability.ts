import { loadRemoteMachines, remoteRequest } from "./connections";
import { resolveHomeMachine } from "./homeMachine";
import type { HostDescriptor, RemoteMachine } from "./protocol";

const described = new Map<string, Promise<string[]>>();

/** The home machine, when its host advertises `capability`. An unreachable
 * host rejects rather than reading as absent, so callers never fall back to
 * this computer's own copy while the shared one is merely out of reach. */
export async function homeWith(capability: string): Promise<RemoteMachine | undefined> {
  const home = resolveHomeMachine(await loadRemoteMachines());
  if (!home) return undefined;
  let capabilities = described.get(home.id);
  if (!capabilities) {
    capabilities = remoteRequest<HostDescriptor>(home.id, "environment.describe").then(
      (descriptor) => descriptor.capabilities ?? [],
    );
    described.set(home.id, capabilities);
    // Asked again next time rather than written off.
    capabilities.catch(() => described.delete(home.id));
  }
  return (await capabilities).includes(capability) ? home : undefined;
}
