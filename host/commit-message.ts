import type { RemoteProvider } from "../src/features/connections/model/protocol";
import {
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  formatCommitMessage,
  parseCommitMessage,
  parsePrContent,
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

export type RangeContext = { base: string; head: string; commitSummary: string; diffSummary: string; diffPatch: string };

/** A pull request's title and body, written on the host from its branch's
 * commits and diff, as the desktop writes one for a local project. */
export async function hostPrContent(input: {
  cwd: string;
  context: RangeContext;
  installed: readonly RemoteProvider[];
  providers: Partial<Record<RemoteProvider, HostProvider>>;
  preferred?: unknown;
}): Promise<{ title: string; body: string; base: string; head: string }> {
  const order =
    typeof input.preferred === "string" && TEXT_ORDER.includes(input.preferred as RemoteProvider)
      ? [input.preferred as RemoteProvider, ...TEXT_ORDER.filter((id) => id !== input.preferred)]
      : TEXT_ORDER;
  const provider = order.find((id) => input.installed.includes(id) && input.providers[id]?.runText);
  if (!provider) throw new Error("No provider on this machine can write pull request content");
  const output = await input.providers[provider]!.runText!({
    cwd: input.cwd,
    prompt: buildPrContentPrompt({
      baseBranch: input.context.base,
      headBranch: input.context.head,
      commitSummary: input.context.commitSummary,
      diffSummary: input.context.diffSummary,
      diffPatch: input.context.diffPatch,
    }),
    timeoutMs: TIMEOUT_MS,
  });
  const parsed = parsePrContent(output);
  if (!parsed) throw new Error("Could not write the pull request content");
  return { ...parsed, base: input.context.base, head: input.context.head };
}
