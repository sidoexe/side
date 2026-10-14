import { useEffect, useState } from "react";
import { useRemoteMachines } from "../../features/connections/model/connections";
import {
  HOME_MACHINE_CHANGED,
  resolveHomeMachine,
} from "../../features/connections/model/homeMachine";
import type { RemoteMachine } from "../../features/connections/model/protocol";

/** The home machine, followed as machines and the saved choice change. */
export function useHomeMachine(): RemoteMachine | undefined {
  const { machines, loaded } = useRemoteMachines();
  const [, setChoiceVersion] = useState(0);
  useEffect(() => {
    const changed = () => setChoiceVersion((value) => value + 1);
    window.addEventListener(HOME_MACHINE_CHANGED, changed);
    return () => window.removeEventListener(HOME_MACHINE_CHANGED, changed);
  }, []);
  return loaded ? resolveHomeMachine(machines) : undefined;
}
