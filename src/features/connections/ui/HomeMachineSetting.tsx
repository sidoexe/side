import { useEffect, useState } from "react";
import {
  HOME_MACHINE_CHANGED,
  homeMachineChoice,
  resolveHomeMachine,
  setHomeMachine,
} from "../model/homeMachine";
import type { RemoteMachine } from "../model/protocol";

/** Which machine keeps Colleagues, asked only when there is a choice. */
export function HomeMachineSetting({ machines }: { machines: RemoteMachine[] }) {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((value) => value + 1);
    window.addEventListener(HOME_MACHINE_CHANGED, bump);
    return () => window.removeEventListener(HOME_MACHINE_CHANGED, bump);
  }, []);
  if (machines.length < 2) return null;
  const home = resolveHomeMachine(machines);

  return (
    <div data-setting-id="home-machine" className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold text-content">Colleagues live on</h3>
      <select
        aria-label="Colleagues live on"
        className="w-full rounded-lg border border-content/15 bg-content/3 px-3 py-2 text-[13px] outline-none focus:border-content/35"
        value={home?.environmentId ?? homeMachineChoice() ?? ""}
        onChange={(event) => setHomeMachine(event.target.value || undefined)}
      >
        {home ? null : <option value="">This computer</option>}
        {machines.map((machine) => (
          <option key={machine.id} value={machine.environmentId}>
            {machine.name}
          </option>
        ))}
      </select>
    </div>
  );
}
