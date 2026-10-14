import type { RemoteMachine } from "./protocol";

/**
 * The home machine is the host that keeps what follows the user from one
 * computer to another: Colleagues, their files and their conversations.
 * Projects are not moved there; each opens where it was chosen, on this
 * computer or on a machine.
 */
const KEY = "side.homeMachine.v1";
export const HOME_MACHINE_CHANGED = "side:home-machine-changed";

/** The chosen environment, `undefined` when nothing was chosen and the
 * single connected machine is used. */
export function homeMachineChoice(): string | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    const id =
      value && typeof value === "object"
        ? (value as { environmentId?: unknown }).environmentId
        : undefined;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}

/** An environment id, or `undefined` for the automatic choice. */
export function setHomeMachine(environmentId: string | undefined): void {
  try {
    if (environmentId === undefined) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify({ environmentId }));
  } catch {
    /* the choice lasts for this run */
  }
  window.dispatchEvent(new Event(HOME_MACHINE_CHANGED));
}

/** The machine Colleagues live on. With no saved choice, a desktop
 * connected to exactly one machine uses that one. */
export function resolveHomeMachine(
  machines: readonly RemoteMachine[],
): RemoteMachine | undefined {
  const choice = homeMachineChoice();
  if (choice) {
    const chosen = machines.find((machine) => machine.environmentId === choice);
    if (chosen) return chosen;
  }
  return machines.length === 1 ? machines[0] : undefined;
}
