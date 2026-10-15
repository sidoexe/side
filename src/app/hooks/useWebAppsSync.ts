import { useEffect, useRef } from "react";
import { useRemoteMachines } from "../../features/connections/model/connections";
import { subscribeWebApps } from "../../features/web-apps/model/webApps";
import { syncWebApps } from "../../features/web-apps/model/webAppsSync";

const CHECK_MS = 60_000;

/** Keeps the web apps, and their logins, the same on this desktop and every
 * connected host, and through them on the other desktops. */
export function useWebAppsSync() {
  const { machines, loaded } = useRemoteMachines();
  const machinesRef = useRef(machines);
  machinesRef.current = machines;
  useEffect(() => {
    if (!loaded) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running: Promise<void> = Promise.resolve();
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // One round at a time: a round adopting a list triggers another.
        running = running.then(() => syncWebApps(machinesRef.current));
      }, 1_000);
    };
    soon();
    const interval = setInterval(soon, CHECK_MS);
    const off = subscribeWebApps(soon);
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
      off();
    };
  }, [loaded, machines.length]);
}
