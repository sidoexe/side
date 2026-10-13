import { invoke } from "@tauri-apps/api/core";
import { setRemotePtySpawner } from "../../../platform/tauri/pty";
import { remoteMachineFor } from "./connections";
import { parseRemotePath } from "./remoteProjects";

/**
 * Terminals in a connected machine's folders run `ssh -t` to that machine,
 * through the SSH target its host tunnel uses (see `pty_spawn_remote`), so
 * they stream like local ones. A URL-only connection has no SSH target and
 * cannot open one.
 */
export async function spawnRemotePty(
  id: string,
  cwd: string,
  cols: number,
  rows: number,
): Promise<void> {
  const parsed = parseRemotePath(cwd);
  if (!parsed) throw new Error("Invalid remote folder");
  const machine = await remoteMachineFor(parsed.environmentId);
  if (!machine) throw new Error("Connect this project’s machine to open a terminal.");
  if (!machine.ssh) throw new Error("Terminals need a machine connected through SSH.");
  await invoke("pty_spawn_remote", {
    id,
    machineId: machine.id,
    cwd: parsed.hostPath,
    cols,
    rows,
  });
}

setRemotePtySpawner(spawnRemotePty);
