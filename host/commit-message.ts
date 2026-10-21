import type { RemoteProvider } from "../src/features/connections/model/protocol";
import {
  buildCommitMessagePrompt,
  formatCommitMessage,
  parseCommitMessage,
} from "../src/features/source-control/model/gitText";
import type { HostProvider } from "./providers";

const TEXT_ORDER: RemoteProvider[] = ["claude", "cursor", "codex", "grok", "opencode", "pi", "omp", "devin"];
const TIMEOUT_MS = 90_000;

export type StagedContext = { branch: string | null; summary: string; patch: string };

/** The host's own commit message: the staged diff, read on this machine, and
 * the first installed provider that can answer a one-shot prompt. */
export async function hostCommitMessage(input: {
  cwd: string;
  context: StagedContext;
  installed: readonly RemoteProvider[];
  providers: Partial<Record<RemoteProvider, HostProvider>>;
  preferred?: unknown;
}): Promise<string> {
  const order =
    typeof input.preferred === "string" && TEXT_ORDER.includes(input.preferred as RemoteProvider)
      ? [input.preferred as RemoteProvider, ...TEXT_ORDER.filter((id) => id !== input.preferred)]
      : TEXT_ORDER;
  const provider = order.find(
    (id) => input.installed.includes(id) && input.providers[id]?.runText,
  );
  if (!provider) throw new Error("No provider on this machine can write a commit message");
  const output = await input.providers[provider]!.runText!({
    cwd: input.cwd,
    prompt: buildCommitMessagePrompt({
      branch: input.context.branch,
      stagedSummary: input.context.summary,
      stagedPatch: input.context.patch,
    }),
    timeoutMs: TIMEOUT_MS,
  });
  const parsed = parseCommitMessage(output);
  if (parsed) return formatCommitMessage(parsed);
  const snippet = output.trim().replace(/\s+/g, " ").slice(0, 240);
  throw new Error(
    snippet
      ? `Could not generate a commit message. Model replied: ${snippet}`
      : "Could not generate a commit message. The model returned no text.",
  );
}
