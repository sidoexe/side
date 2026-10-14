// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { machineRail } from "./remoteRail";

const ENV = "fb911252-c87d-46bd-9299-a3873d47be50";
const remote = (path: string, env = ENV) => `remote://${env}${path}`;

beforeEach(() => localStorage.clear());

it("lists a machine's rail projects in rail order, without archived ones or other machines", () => {
  localStorage.setItem(
    "monocode.recentProjects",
    JSON.stringify([
      { path: remote("/Users/sido/side"), openedAt: 3 },
      { path: remote("/Users/sido/athlnet/app"), openedAt: 2 },
      { path: remote("/Users/sido/athlnet/ecosystem"), openedAt: 1 },
      { path: remote("/Users/sido/old"), openedAt: 0 },
      { path: remote("/home/me/x", "other-env"), openedAt: 4 },
      { path: "/Users/sido/local", openedAt: 5 },
    ]),
  );
  localStorage.setItem(
    "monocode.projectRailOrder",
    JSON.stringify([remote("/Users/sido/athlnet/app"), remote("/Users/sido/athlnet/ecosystem"), remote("/Users/sido/side")]),
  );
  localStorage.setItem(
    "monocode.archivedProjects",
    JSON.stringify([{ path: remote("/Users/sido/old"), archivedAt: 1 }, { path: remote("/Users/sido/Tp Visualisation"), archivedAt: 1 }]),
  );
  expect(machineRail(ENV)).toEqual({
    projects: ["/Users/sido/athlnet/app", "/Users/sido/athlnet/ecosystem", "/Users/sido/side"],
    archived: ["/Users/sido/old", "/Users/sido/Tp Visualisation"],
  });
});
