import { invoke } from "@tauri-apps/api/core";

/**
 * Where automations are kept and claimed: this computer's session store.
 * The calls take and return what the native commands do.
 */
type AutomationCommand =
  | "automations_list"
  | "automations_upsert"
  | "automations_delete"
  | "automation_runs_list"
  | "automation_runs_recover"
  | "automation_run_now"
  | "automations_claim_due"
  | "automations_claim_event"
  | "automation_run_update";

export function automationCall<T>(
  command: AutomationCommand,
  args: Record<string, unknown> = {},
): Promise<T> {
  return invoke<T>(command, args);
}
