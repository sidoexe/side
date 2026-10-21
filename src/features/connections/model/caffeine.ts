import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { IS_LINUX, IS_MAC } from "../../../platform/tauri/platform";
import { useRemoteMachines, remoteRequest } from "./connections";
import { machineCapabilities } from "./homeCapability";
import type { RemoteMachine } from "./protocol";
import { parseRemotePath } from "./remoteProjects";

/**
 * Caffeine mode keeps the machine that runs a project from idle-sleeping:
 * this computer for a local project, the host for a project on a machine.
 */

const CHANGED = "side:caffeine-changed";

/** Whether the machine is kept awake; undefined where it cannot be. */
async function readCaffeine(machine?: RemoteMachine): Promise<boolean | undefined> {
  if (!machine) return IS_MAC || IS_LINUX ? invoke<boolean>("caffeine_status") : undefined;
  if (!(await machineCapabilities(machine)).includes("caffeine")) return undefined;
  return (await remoteRequest<{ on: boolean }>(machine.id, "caffeine.status")).on;
}

async function writeCaffeine(on: boolean, machine?: RemoteMachine): Promise<boolean> {
  const result = machine
    ? (await remoteRequest<{ on: boolean }>(machine.id, "caffeine.set", { on })).on
    : await invoke<boolean>("caffeine_set", { on });
  window.dispatchEvent(new CustomEvent(CHANGED));
  return result;
}

export type Caffeine = {
  /** Where caffeine mode applies: this computer, or the host's name. */
  machineName?: string;
  /** Undefined until read, or where the machine cannot stay awake. */
  on?: boolean;
  busy: boolean;
  error?: string;
  toggle: () => void;
};

/** Caffeine mode of the machine that runs `project`. */
export function useCaffeine(project?: string): Caffeine {
  const environmentId = project ? parseRemotePath(project)?.environmentId : undefined;
  const { machines, loaded } = useRemoteMachines(!!environmentId);
  const machine = environmentId
    ? machines.find((entry) => entry.environmentId === environmentId)
    : undefined;
  // A remote project whose machine is not known yet, or no longer connected.
  const missing = !!environmentId && (!loaded || !machine);
  const [state, setState] = useState<{ on?: boolean; busy: boolean; error?: string }>({
    busy: false,
  });

  useEffect(() => {
    setState({ busy: false });
    if (missing) return;
    let disposed = false;
    const refresh = () => {
      readCaffeine(machine).then(
        (on) => {
          if (!disposed) setState((prev) => ({ ...prev, on, error: undefined }));
        },
        () => {
          if (!disposed) setState((prev) => ({ ...prev, on: undefined }));
        },
      );
    };
    refresh();
    // Another window, or another desktop on the same host, may switch it.
    window.addEventListener(CHANGED, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      window.removeEventListener(CHANGED, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [machine, missing]);

  const toggle = useCallback(() => {
    if (missing || state.busy || state.on === undefined) return;
    const next = !state.on;
    setState((prev) => ({ ...prev, busy: true, error: undefined }));
    writeCaffeine(next, machine).then(
      (on) => setState({ on, busy: false }),
      (error) =>
        setState((prev) => ({
          ...prev,
          busy: false,
          error: error instanceof Error ? error.message : String(error),
        })),
    );
  }, [machine, missing, state.busy, state.on]);

  return {
    machineName: machine?.name,
    on: missing ? undefined : state.on,
    busy: state.busy,
    error: state.error,
    toggle,
  };
}
