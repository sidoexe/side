import { useEffect, useRef } from "react";
import { useRemoteMachines } from "../../features/connections/model/connections";
import { forgetCapabilities } from "../../features/connections/model/homeCapability";
import { updateHostIfOlder } from "../../features/connections/model/hostAutoUpdate";
import { readAppVersion } from "../model/updater";

const CHECK_MS = 5 * 60_000;
export const HOST_UPDATED_EVENT = "side:host-updated";

/** Keeps every SSH machine's host on this desktop's release: checked at
 * launch, after each app update, and every few minutes while a host is busy. */
export function useHostAutoUpdate() {
  const { machines, loaded } = useRemoteMachines();
  const machinesRef = useRef(machines);
  machinesRef.current = machines;
  useEffect(() => {
    if (!loaded) return;
    let disposed = false;
    let running = false;
    // A failed update (no package for this release, SSH refused) is retried
    // from Settings or on the next launch, not every few minutes.
    const failed = new Set<string>();
    const pass = async () => {
      if (running) return;
      running = true;
      try {
        const app = await readAppVersion();
        for (const machine of machinesRef.current) {
          if (disposed) return;
          if (failed.has(machine.id)) continue;
          const result = await updateHostIfOlder(machine, app).catch(() => "failed" as const);
          if (result === "failed" || result === "skipped") failed.add(machine.id);
          if (result === "updated") {
            forgetCapabilities(machine.id);
            window.dispatchEvent(new CustomEvent(HOST_UPDATED_EVENT, { detail: machine.id }));
          }
        }
      } finally {
        running = false;
      }
    };
    void pass();
    const timer = setInterval(() => void pass(), CHECK_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [loaded, machines.length]);
}
