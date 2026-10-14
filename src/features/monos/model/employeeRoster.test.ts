import { expect, it } from "vitest";
import { EmployeeRosterSync, mergeRosters } from "./employeeRoster";
import type { Mono } from "./mono";

const mono = (id: string, extra: Partial<Mono> = {}): Mono => ({
  id,
  mascot: "crab",
  color: "red",
  projects: [],
  ...extra,
});

it("keeps this desktop's changes and takes everything else from the host", () => {
  const base = [mono("a"), mono("b"), mono("c")];
  const local = [mono("a", { name: "Renamed here" }), mono("b"), mono("d")];
  const remote = [mono("c"), mono("b", { color: "blue" }), mono("a"), mono("e")];
  expect(mergeRosters(base, local, remote)).toEqual([
    // Removed here (c) stays removed; renamed here (a) keeps the new name.
    mono("b", { color: "blue" }),
    mono("a", { name: "Renamed here" }),
    mono("e"),
    mono("d"),
  ]);
});

it("does not bring back an employee another desktop removed", () => {
  expect(mergeRosters([mono("a"), mono("b")], [mono("a"), mono("b")], [mono("a")])).toEqual([
    mono("a"),
  ]);
});

function harness(initial: { revision: number; roster: unknown[] }, local: Mono[]) {
  const host = { ...initial, saves: 0, conflictOnce: false };
  const state = { local };
  const sync = new EmployeeRosterSync(
    async <T,>(_machine: unknown, method: string, params?: any): Promise<T> => {
      if (method === "employees.roster") return { revision: host.revision, roster: host.roster } as T;
      if (host.conflictOnce) {
        host.conflictOnce = false;
        host.revision++;
        host.roster = [...host.roster, mono("other")];
        throw "Host rejected request: conflict";
      }
      if (params.expectedRevision !== host.revision) throw "Host rejected request: conflict";
      host.saves++;
      host.revision++;
      host.roster = params.roster;
      return { revision: host.revision, roster: host.roster } as T;
    },
    async () => ({ id: "pro", name: "Pro", endpoint: "", environmentId: "env" }),
    () => state.local,
    (roster) => {
      state.local = roster as Mono[];
    },
  );
  return { host, state, sync };
}

it("seeds an empty host with this desktop's roster", async () => {
  const { host, sync } = harness({ revision: 0, roster: [] }, [mono("a")]);
  await sync.sync();
  expect(host).toMatchObject({ revision: 1, roster: [mono("a")] });
});

it("adds this desktop's own employees to the host's on first contact", async () => {
  const { host, state, sync } = harness({ revision: 4, roster: [mono("h")] }, [mono("a")]);
  await sync.sync();
  expect(state.local).toEqual([mono("h"), mono("a")]);
  expect(host).toMatchObject({ revision: 5, roster: [mono("h"), mono("a")] });
  await sync.sync();
  expect(host.saves).toBe(1);
});

it("pushes a local change and merges when another desktop saved first", async () => {
  const { host, state, sync } = harness({ revision: 1, roster: [mono("a")] }, [mono("a")]);
  await sync.sync();
  state.local = [mono("a", { name: "New" })];
  host.conflictOnce = true;
  await sync.sync();
  expect(host.roster).toEqual([mono("a", { name: "New" }), mono("other")]);
  expect(state.local).toEqual(host.roster);
});

it("never sends an employee kept on this computer only to the host", async () => {
  const { host, state, sync } = harness(
    { revision: 1, roster: [mono("h")] },
    [mono("a"), mono("solo", { localOnly: true }), mono("b")],
  );
  await sync.sync();
  expect(host.roster).toEqual([mono("h"), mono("a"), mono("b")]);
  expect(state.local).toEqual([mono("h"), mono("a"), mono("solo", { localOnly: true }), mono("b")]);
  await sync.sync();
  expect(host.saves).toBe(1);
});

it("drops the host's copy of an employee made local here", async () => {
  const { host, state, sync } = harness({ revision: 1, roster: [mono("a"), mono("b")] }, [
    mono("a"),
    mono("b"),
  ]);
  await sync.sync();
  state.local = [mono("a", { localOnly: true }), mono("b")];
  await sync.sync();
  expect(host.roster).toEqual([mono("b")]);
  expect(state.local).toEqual([mono("a", { localOnly: true }), mono("b")]);
});
