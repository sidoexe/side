import { invoke } from "@tauri-apps/api/core";
import { sessionNeedsInput, type Session } from "../../sessions/model/session";
import { REMOTE_PATH_PREFIX } from "../../../shared/lib/remotePaths";

let lastCount = -1;
let localSessions: readonly Session[] = [];
/** Host sessions waiting on the user, as their hosts' lists last said. */
let remoteWaiting = 0;

function render(): void {
  let count = remoteWaiting;
  // A host session open in a tab is counted from its host's list instead.
  for (const session of localSessions)
    if (!session.cwd.startsWith(REMOTE_PATH_PREFIX) && sessionNeedsInput(session)) count++;
  if (count === lastCount) return;
  lastCount = count;
  void invoke("set_dock_badge", { count }).catch(() => {});
}

/** Push the pending-approval count to the macOS Dock badge. */
export function syncDockBadge(sessions: Session[]): void {
  localSessions = sessions;
  render();
}

/** Every host session waiting on the user, open in a tab or not. */
export function setRemoteWaitingCount(count: number): void {
  remoteWaiting = count;
  render();
}
