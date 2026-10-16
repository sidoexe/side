import { loadRemoteMachines, remoteRequest } from "./connections";
import { resolveHomeMachine } from "./homeMachine";
import type { HostDescriptor, RemoteMachine } from "./protocol";

const described = new Map<string, { at: number; capabilities: Promise<string[]> }>();
/** A host updated behind this window's back gains capabilities; ask again
 * after this long rather than only once per run. */
const DESCRIBE_TTL_MS = 5 * 60_000;

/** What a connected machine's host advertises, asked again every few minutes. */
export function machineCapabilities(
  machine: RemoteMachine,
  now = Date.now(),
): Promise<string[]> {
  const known = described.get(machine.id);
  if (known && now - known.at < DESCRIBE_TTL_MS) return known.capabilities;
  const capabilities = remoteRequest<HostDescriptor>(machine.id, "environment.describe").then(
    (descriptor) => descriptor.capabilities ?? [],
  );
  described.set(machine.id, { at: now, capabilities });
  // Asked again next time rather than written off.
  capabilities.catch(() => {
    if (described.get(machine.id)?.capabilities === capabilities) described.delete(machine.id);
  });
  return capabilities;
}

/** Asks a machine again, after its host was updated. */
export function forgetCapabilities(machineId: string): void {
  described.delete(machineId);
}

/** The home machine, when its host advertises `capability`. An unreachable
 * host rejects rather than reading as absent, so callers never fall back to
 * this computer's own copy while the shared one is merely out of reach. */
export async function homeWith(capability: string): Promise<RemoteMachine | undefined> {
  const home = resolveHomeMachine(await loadRemoteMachines());
  if (!home) return undefined;
  return (await machineCapabilities(home)).includes(capability) ? home : undefined;
}
