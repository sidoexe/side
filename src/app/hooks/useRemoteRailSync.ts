import { useEffect, useRef } from "react";
import { useRemoteMachines } from "../../features/connections/model/connections";
import { publishRails } from "../../features/connections/model/remoteRail";
import {
  subscribeArchivedProjects,
  subscribeProjectPathsChanged,
} from "../../features/projects/model/recents";

const CHECK_MS = 60_000;

/** Keeps each machine's host told which of its projects the rail shows, so
 * the browser app lists the same ones in the same order. */
export function useRemoteRailSync() {
  const { machines, loaded } = useRemoteMachines();
  const machinesRef = useRef(machines);
  machinesRef.current = machines;
  useEffect(() => {
    if (!loaded) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void publishRails(machinesRef.current), 500);
    };
    soon();
    const interval = setInterval(soon, CHECK_MS);
    const offPaths = subscribeProjectPathsChanged(soon);
    const offArchive = subscribeArchivedProjects(soon);
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
      offPaths();
      offArchive();
    };
  }, [loaded, machines.length]);
}
