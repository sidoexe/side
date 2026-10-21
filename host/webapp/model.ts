/** The host protocol as far as the phone app reads it (ios/SideMobile/Host/Models.swift):
 * every field the host may omit is optional, so a newer host still works. */

export type HostDescriptor = {
  protocolVersion: number;
  environmentId: string;
  name: string;
  providers: string[];
  capabilities: string[];
  version?: string;
};

export type HostProject = { id: string; cwd: string; name: string };

export type HostSessionSummary = {
  id: string;
  projectId: string;
  title: string;
  harness: string;
  model?: string;
  status: string;
  updatedAt: number;
  archived?: boolean;
  pinned?: boolean;
  needsInput?: boolean;
  branch?: string;
  draft?: boolean;
  repo?: string;
  cwd?: string;
  worktreeCwd?: string;
  /** Its last turn finished and nobody has checked it yet. */
  toReview?: boolean;
  /** Its last turn ended on an error. Older hosts never say so. */
  failed?: boolean;
};

export const isRunning = (s: HostSessionSummary) => s.status === "running";
/** Finished and waiting to be checked: it stays until marked so. */
export const isDone = (s: HostSessionSummary) => s.toReview === true && !isRunning(s) && s.needsInput !== true;
/** Done because its turn ended on an error. */
export const isFailedTurn = (s: HostSessionSummary) => isDone(s) && s.failed === true;
/** Only a saved draft: kept off lists. A draft never hides a session that
 * works, waits on the user or is done, as on desktop. */
export const isDraftOnly = (s: HostSessionSummary) => s.draft === true && !isRunning(s) && s.needsInput !== true && !isDone(s);

export type UsageWindow = { used?: number; resetsAt?: number };
export type HostAccountSummary = {
  id: string;
  provider: string;
  label: string;
  /** The accounts an "auto" entry balances across; absent on a real account. */
  pool?: string[];
  usage?: {
    fiveHour?: UsageWindow;
    sevenDay?: UsageWindow;
    error?: string;
    blockedUntil?: number;
    updatedAt?: number;
  };
  /** A named account the Balanced choice may use; absent on older hosts. */
  balanced?: boolean;
};

/** The limit it is waiting out, if still ahead, in Unix milliseconds. */
export const limitedUntil = (account: HostAccountSummary) => {
  const until = account.usage?.blockedUntil;
  return until && until > Date.now() ? until : undefined;
};

export type ModelSetting = {
  id: string;
  label: string;
  kind: string;
  value: string;
  options: { value: string; label: string }[];
};

export type AgentModel = {
  id: string;
  harness: string;
  name: string;
  nativeId?: string;
  settings?: ModelSetting[];
};

/** A session keeps "opus" where the catalog says "claude:opus". */
export const modelMatches = (item: AgentModel, model?: string) =>
  !!model && (item.id === model || item.nativeId === model || item.id === `${item.harness}:${model}`);

/** As `modelEffortSetting`: the select that sets how hard it thinks. */
export const effortSetting = (item?: AgentModel) =>
  item?.settings?.find(
    (setting) => setting.kind === "select" && ["effort", "reasoning", "reasoningEffort", "thinking", "variant"].includes(setting.id),
  );

export type HostModelCatalog = {
  models: Record<string, AgentModel[] | undefined>;
  errors: Record<string, string | undefined>;
};

export type Attachment = { id: string; name: string; mimeType: string; kind: string; size: number };

export type PreviewLine = { number?: number; kind: string; text: string };
export type Block = {
  id: string;
  role: string;
  text: string;
  streaming?: boolean;
  attachments?: Attachment[];
  tool?: {
    title?: string;
    kind?: string;
    status?: string;
    detail?: string;
    preview?: {
      kind?: string;
      path?: string;
      fileName?: string;
      additions?: number;
      deletions?: number;
      query?: string;
      lines?: PreviewLine[];
      output?: string;
    };
  };
  approval?: { requestId: number; decided?: string };
  internal?: boolean;
  draft?: boolean;
  durationMs?: number;
  taskList?: { items: { text: string; status: string }[] };
  plan?: { status?: string };
  notice?: string;
  /** An image the agent generated; it stays on the machine that ran it. */
  image?: { name?: string; alt?: string };
};

export type UserQuestion = {
  id: string;
  header?: string;
  prompt: string;
  multiSelect: boolean;
  allowCustom: boolean;
  options: { id: string; label: string; description?: string }[];
};
export type UserQuestionPrompt = { requestId: number; title?: string; questions: UserQuestion[] };

export type SessionMeta = {
  id: string;
  harness: string;
  model: string;
  modelSettings?: Record<string, string>;
  runtimeMode: string;
  providerAccountId?: string;
  title: string;
  cwd: string;
  busy?: boolean;
  pendingQuestion?: UserQuestionPrompt;
  queuedMessages?: { id: string; text: string }[];
  queueStatus?: string;
  worktreeCwd?: string;
  context?: { used: number; window?: number };
  usageLimit?: { resetsAt?: number; resumeAtReset?: boolean };
  blocks: Block[];
};

export type HostSession = {
  session: SessionMeta;
  projectId: string;
  revision: number;
  runId?: string;
  status: string;
  accountInUse?: string;
};

export const contextRatio = (context?: SessionMeta["context"]) =>
  context?.window && context.window > 0 && context.used >= 0 ? Math.min(1, context.used / context.window) : undefined;

/** The desktop's rail: which projects it lists, in its order. */
export type RailState = { projects: string[]; archived: string[]; backgrounds: Record<string, number> };

export type HostDirectory = { path: string; parent: string | null; entries: { name: string; path: string }[] };

export type HostWebApp = { id: string; name: string; url: string; folder?: string };

export const RUNTIME_MODES: { id: string; label: string }[] = [
  { id: "supervised", label: "Supervised" },
  { id: "auto-accept-edits", label: "Accept edits" },
  { id: "auto", label: "Auto" },
  { id: "full-access", label: "Full access" },
];

export const HARNESS_TITLES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok Build",
  opencode: "OpenCode",
  pi: "Pi",
  omp: "omp",
  fx: "fx",
  hermes: "Hermes Agent",
  antigravity: "Antigravity",
  devin: "Devin",
};

/** As `sessionDisplayTitle`: without the "claude · " the harness prefixes. */
export function displayTitle(title: string, harness: string) {
  if (title.startsWith(`${harness} · `)) return title.slice(harness.length + 3);
  if (!title || title === harness || title === HARNESS_TITLES[harness]) return "New session";
  return title;
}

/** What Resume sends, as the desktop's `CONTINUE_PROMPT` (inFlight.ts). */
export const CONTINUE_PROMPT = "Continue from where you left off.";

/** Relative time as the sidebar shows it: "now", "5m", "3h", "2d". */
export function ago(ms: number) {
  const seconds = Math.max(0, Date.now() / 1000 - ms / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)}d`;
  return `${Math.floor(seconds / (86400 * 30))}mo`;
}

/** A home-relative path, as the desktop shows a working copy. */
export const tilde = (path: string) => path.replace(/^\/(Users|home)\/[^/]+/, "~");

export const folderName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

/** "3:20 PM" today, "Oct 19, 3:20 PM" later: when a window or limit ends. */
export function resetTime(ms: number) {
  const date = new Date(ms);
  const today = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return today ? time : `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

/** One line under an account in a menu: why it needs the user, or its usage. */
export function accountStatus(account: HostAccountSummary, accounts: HostAccountSummary[]) {
  if (account.pool) {
    const names = account.pool.flatMap((id) => accounts.find((item) => item.id === id)?.label ?? []);
    return names.length ? `Between ${names.join(", ")}` : "Moves on at a limit";
  }
  if (account.usage?.error) return "Sign-in needed";
  const until = limitedUntil(account);
  if (until) return `Limited until ${resetTime(until)}`;
  return [
    account.usage?.fiveHour?.used !== undefined ? `5h ${Math.round(account.usage.fiveHour.used)}%` : "",
    account.usage?.sevenDay?.used !== undefined ? `7d ${Math.round(account.usage.sevenDay.used)}%` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
