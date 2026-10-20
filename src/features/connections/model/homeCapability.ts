import { remoteRequest } from "./connections";
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
