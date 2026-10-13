import { invoke } from "@tauri-apps/api/core";
import { remoteRequest } from "../../connections/model/connections";
import { homeWith } from "../../connections/model/homeCapability";
import type { RemoteMachine } from "../../connections/model/protocol";

/**
 * Where automations are kept and claimed. With a home machine whose host
 * keeps them, every desktop lists the host's and claims runs there, so each
 * occurrence or Inbox event runs once, on whichever desktop claimed it.
 * Without one, this computer's session store is used, as before. The calls
 * take and return what the native commands do.
 */
const HOST_METHOD: Record<string, string> = {
  automations_list: "automations.list",
  automations_upsert: "automations.upsert",
  automations_delete: "automations.delete",
  automation_runs_list: "automations.runs",
  automation_runs_recover: "automations.recover",
  automation_run_now: "automations.runNow",
  automations_claim_due: "automations.claimDue",
  automations_claim_event: "automations.claimEvent",
  automation_run_update: "automations.updateRun",
};

const IMPORTED_KEY = "side.automationsImported.v1";
const importing = new Map<string, Promise<void>>();

function imported(): Record<string, true> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(IMPORTED_KEY) ?? "{}");
    return value && typeof value === "object" ? (value as Record<string, true>) : {};
  } catch {
    return {};
  }
}

/** Copies this computer's automations to the host once, as they are; the
 * host keeps any it already has. Run history stays behind. */
function importOnce(home: RemoteMachine): Promise<void> {
  const key = home.environmentId;
  if (imported()[key]) return Promise.resolve();
  let pending = importing.get(key);
  if (!pending) {
    pending = (async () => {
      const local = await invoke<unknown[]>("automations_list");
      for (const automation of Array.isArray(local) ? local : [])
        await remoteRequest(home.id, "automations.import", { automation });
      try {
        localStorage.setItem(IMPORTED_KEY, JSON.stringify({ ...imported(), [key]: true }));
      } catch {
        /* imported again next time; the host keeps its own copies */
      }
    })().finally(() => importing.delete(key));
    importing.set(key, pending);
  }
  return pending;
}

export async function automationCall<T>(
  command: keyof typeof HOST_METHOD,
  args: Record<string, unknown> = {},
): Promise<T> {
  const home = await homeWith("automations");
  if (!home) return invoke<T>(command, args);
  await importOnce(home);
  return remoteRequest<T>(home.id, HOST_METHOD[command], args);
}
