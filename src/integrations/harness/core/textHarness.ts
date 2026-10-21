import type { HarnessId } from "../../../features/sessions/model/session";
import { isHarnessAvailable } from "./availability";
import { invokeWorkspace } from "../../../platform/tauri/fs";
import { REMOTE_PATH_PREFIX } from "../../../shared/lib/remotePaths";
import type { PrContent } from "../../../features/source-control/model/gitText";
import {
  generateHarnessCommitMessage,
  generateHarnessPrContent,
  warmupHarnessText,
} from "./registry";

const TEXT_HARNESSES: HarnessId[] = [
  "claude",
  "cursor",
  "codex",
  "grok",
  "opencode",
];

/** Pick the harness used for titles, commit messages, and PR text. */
export function pickTextHarness(preferred?: HarnessId): HarnessId {
  const ordered =
    preferred && TEXT_HARNESSES.includes(preferred)
      ? [preferred, ...TEXT_HARNESSES.filter((id) => id !== preferred)]
      : TEXT_HARNESSES;
  for (const id of ordered) {
    if (isHarnessAvailable(id)) return id;
  }
  return preferred && TEXT_HARNESSES.includes(preferred) ? preferred : "cursor";
}

export function warmupText(cwd: string, preferred?: HarnessId): Promise<void> {
  return warmupHarnessText(pickTextHarness(preferred), cwd);
}

export function generateCommitMessage(
  cwd: string,
  preferred?: HarnessId,
  signal?: AbortSignal,
  paths?: readonly string[],
): Promise<string> {
  // A project on another machine is staged there; its host writes the message.
  if (cwd.startsWith(REMOTE_PATH_PREFIX))
    return invokeWorkspace<string>("generate_commit_message", {
      cwd,
      harness: preferred ?? null,
      ...(paths ? { paths: [...paths] } : {}),
    });
  return generateHarnessCommitMessage(pickTextHarness(preferred), cwd, signal, paths);
}

export function generatePrContent(
  cwd: string,
  preferred?: HarnessId,
): Promise<(PrContent & { base: string; head: string }) | null> {
  // A branch on another machine is read there; its host writes the text.
  if (cwd.startsWith(REMOTE_PATH_PREFIX))
    return invokeWorkspace<PrContent & { base: string; head: string }>("generate_pr_content", {
      cwd,
      harness: preferred ?? null,
    });
  return generateHarnessPrContent(pickTextHarness(preferred), cwd);
}
