import { useSyncExternalStore } from "react";

/** Where the app footer leaves room for a remote session's host accounts,
 * in place of this computer's usage chips. */
type Slot = { sessionId: string; element: HTMLElement };

let slot: Slot | undefined;
const listeners = new Set<() => void>();

export function setRemoteAccountSlot(next: Slot | undefined) {
  if (slot?.sessionId === next?.sessionId && slot?.element === next?.element) return;
  slot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The footer slot, when `sessionId` is the conversation the footer shows. */
export function useRemoteAccountSlot(sessionId: string): HTMLElement | undefined {
  const current = useSyncExternalStore(subscribe, () => slot);
  return current?.sessionId === sessionId ? current.element : undefined;
}
