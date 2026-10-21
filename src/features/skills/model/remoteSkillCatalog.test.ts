import { expect, it, vi } from "vitest";
import { loadSkills } from "./skills";
import { registerHarness, type HarnessAdapter } from "../../../integrations/harness/core/registry";
import { remoteRequest } from "../../connections/model/connections";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../connections/model/connections", () => ({
  remoteMachineFor: vi.fn(async () => ({ id: "work", name: "Work", endpoint: "ssh://work", environmentId: "env" })),
  remoteSessionFor: vi.fn(() => "host-session"),
  remoteRequest: vi.fn(async () => [{ name: "review", description: "Review the diff", invocation: "/review", source: "pi" }]),
}));

it("asks a session's host for its agent's own commands", async () => {
  // Pi has a native catalog; locally it would run its CLI here.
  const discover = vi.fn(async () => []);
  registerHarness({ id: "pi", live: true, commands: { discover } } as unknown as HarnessAdapter);
  const skills = await loadSkills({ harness: "pi", cwd: "remote://env/home/me/repo", sessionId: "shell" });
  expect(skills).toEqual([expect.objectContaining({ kind: "native", name: "review", invocation: "/review" })]);
  expect(remoteRequest).toHaveBeenCalledWith("work", "commands.list", { harness: "pi", cwd: "/home/me/repo", sessionId: "host-session" });
  expect(discover).not.toHaveBeenCalled();
});
