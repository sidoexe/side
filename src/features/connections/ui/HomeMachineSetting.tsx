import { useEffect, useState } from "react";
import { prettyCwd } from "../../../shared/lib/paths";
import {
  HOME_MACHINE_CHANGED,
  MIGRATION_REPORT_CHANGED,
  homeMachineChoice,
  loadMigrationReport,
  resolveHomeMachine,
  setHomeMachine,
} from "../model/homeMachine";
import type { RemoteMachine } from "../model/protocol";

const AUTO = "";
const OFF = "off";

/** Picks the host that owns every project and conversation (sIDE's
 * host-only mode), and shows what moved there from this desktop. */
export function HomeMachineSetting({ machines }: { machines: RemoteMachine[] }) {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((value) => value + 1);
    window.addEventListener(HOME_MACHINE_CHANGED, bump);
    window.addEventListener(MIGRATION_REPORT_CHANGED, bump);
    return () => {
      window.removeEventListener(HOME_MACHINE_CHANGED, bump);
      window.removeEventListener(MIGRATION_REPORT_CHANGED, bump);
    };
  }, []);

  const choice = homeMachineChoice();
  const home = resolveHomeMachine(machines);
  const value = choice === null ? OFF : (choice ?? AUTO);
  const report = Object.entries(loadMigrationReport()).sort(
    ([, a], [, b]) => b.at - a.at,
  );
  const imported = report.reduce((sum, [, entry]) => sum + (entry.imported ?? 0), 0);
  const archived = report.filter(([, entry]) => entry.archived);
  const failed = report.flatMap(([, entry]) => entry.failed ?? []);

  return (
    <div data-setting-id="home-machine" className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold text-content">Home machine</h3>
      <p className="text-[12px] leading-relaxed text-content/45">
        Every project opens on this host and every conversation is saved in its
        database, from this computer or any other one connected to it.
      </p>
      <select
        aria-label="Home machine"
        className="w-full rounded-lg border border-content/15 bg-content/3 px-3 py-2 text-[13px] outline-none focus:border-content/35"
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          setHomeMachine(next === OFF ? null : next === AUTO ? undefined : next);
        }}
      >
        <option value={AUTO}>
          Automatic{machines.length === 1 ? ` (${machines[0].name})` : ""}
        </option>
        {machines.map((machine) => (
          <option key={machine.id} value={machine.environmentId}>
            {machine.name}
          </option>
        ))}
        <option value={OFF}>Off: keep projects on this computer</option>
      </select>
      <p className="text-[12px] text-content/50">
        {home
          ? `Projects and conversations live on ${home.name}.`
          : "Host-only mode is off: projects opened here run on this computer."}
      </p>
      {report.length > 0 ? (
        <div className="text-[12px] leading-relaxed text-content/50">
          <div>
            {report.length - archived.length} project
            {report.length - archived.length === 1 ? "" : "s"} moved,{" "}
            {imported} conversation{imported === 1 ? "" : "s"} imported.
          </div>
          {archived.length > 0 ? (
            <div>
              Archived, not found on the host:{" "}
              {archived.map(([path]) => prettyCwd(path)).join(", ")}
            </div>
          ) : null}
          {failed.length > 0 ? (
            <div>{failed.length} conversation(s) could not be imported.</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
