import { beforeEach, expect, it, vi } from "vitest";
import { invokeWorkspace } from "../../../platform/tauri/fs";
import { REMOTE_PATH_PREFIX } from "../../../shared/lib/remotePaths";
import { generateCommitMessage, generatePrContent } from "./textHarness";

vi.mock("../../../platform/tauri/fs", () => ({ invokeWorkspace: vi.fn() }));

beforeEach(() => vi.mocked(invokeWorkspace).mockReset());

it("asks a project's host to write its pull request, as its commit messages", async () => {
  const cwd = `${REMOTE_PATH_PREFIX}env/home/me/repo`;
  vi.mocked(invokeWorkspace).mockResolvedValue({ title: "T", body: "B", base: "main", head: "dev" });
  expect(await generatePrContent(cwd, "claude")).toEqual({ title: "T", body: "B", base: "main", head: "dev" });
  expect(invokeWorkspace).toHaveBeenCalledWith("generate_pr_content", { cwd, harness: "claude" });
  vi.mocked(invokeWorkspace).mockResolvedValue("Message");
  await generateCommitMessage(cwd);
  expect(invokeWorkspace).toHaveBeenLastCalledWith("generate_commit_message", { cwd, harness: null });
});
