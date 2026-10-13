import type { BuiltinSkill } from "../../skills/model/skills";
import type { Block } from "./session";

export const OPERATOR_COMMAND: BuiltinSkill = {
  kind: "builtin",
  name: "operator",
  invocation: "operator",
  description:
    "Give this thread access to sIDE sessions, folders, and notes.",
  scope: "builtin",
  source: "monocode",
};

/** Activate app access with a leading composer command. */
export function consumeOperatorCommand(text: string): {
  text: string;
  matched: boolean;
} {
  // Keep the old spellings as unlisted aliases for existing drafts and threads.
  const match = text.match(/^\s*\/(?:operator|mono|monocode)(?=\s|$)\s*/i);
  if (!match) return { text, matched: false };
  return { text: text.slice(match[0].length), matched: true };
}

const LEGACY_COMMAND = /^\s*\/(?:mono|monocode)(?=\s|$)\s*/i;

/** A submitted /operator turn keeps CLI access available in later turns. */
export function isOperatorUserTurn(block: Block): boolean {
  return (
    block.role === "user" &&
    !block.draft &&
    !block.internal &&
    // This persisted field keeps its original name for saved session compatibility.
    (block.monocode === true || LEGACY_COMMAND.test(block.text))
  );
}

/** Old command messages remain enabled and render without their old prefix. */
export function operatorUserPrompt(block: Block): string {
  const legacy = block.text.match(LEGACY_COMMAND);
  if (!legacy) return block.text;
  return (
    block.text.slice(legacy[0].length).trim() ||
    "Explain what you can do in sIDE with the app CLI."
  );
}

export function operatorEnabledInThread(blocks: Block[]): boolean {
  return blocks.some(isOperatorUserTurn);
}

/** What a turn tells its agent about the app CLI: `cli` is the command it
 * runs; `always` for a thread with access built in, such as a Mono's. */
export function operatorAppContext(cli: string, always: boolean): string {
  return `<monocode_app>\n${always ? "App access is always enabled in this thread." : "The user's Operator command enables app access in this thread, including later turns without the command."} You can start session tabs or split session panes right or down, list and create project worktrees, choose a new session's checkout, read, continue, stop, archive or delete other project sessions, save unsent drafts, organize session folders, and read or write saved notes through its local CLI. Run \`${cli} --help\` when you need the exact commands and JSON fields. When reading another session, start with its latest two or three user/assistant exchanges. Request older exchanges with nextBefore or a larger excerpt only if needed. The CLI uses a session credential already in your environment; never print it. New sessions inherit this session's permission mode unless runtimeMode is set explicitly. For a new session with a draft, call sessions.start with its prompt and draft:true; do not submit a seed prompt. The returned ID can be used as besideSessionId to split its pane again or moved into a folder immediately. A normal sessions.start submits its prompt but returns after acceptance, so do not wait for that agent to finish before organizing it.\n</monocode_app>`;
}
