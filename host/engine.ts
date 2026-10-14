import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { renameHostWorktreeBranch, resolveHostWorktree } from "./git-worktrees";
import {
  applyHarnessEvent,
  stopStreaming,
} from "../src/integrations/harness/core/apply";
import { resolveModel } from "../src/features/sessions/model/models";
import { isVisionImage } from "../src/features/sessions/model/attachments";
import type {
  HarnessEvent,
  HarnessSessionInput,
} from "../src/integrations/harness/core/types";
import {
  HARNESS_LABEL,
  RUNTIME_MODES,
  canReplaceSessionTitle,
  formatSessionTitle,
  titleFromPrompt,
  type Session,
} from "../src/features/sessions/model/session";
import { namedWorktreeBranch } from "../src/features/source-control/model/worktrees";
import {
  isRemoteProvider,
  type HostCommand,
  type HostSession,
  type CommandReceipt,
  type RemoteProvider,
} from "../src/features/connections/model/protocol";
import type { HostProvider } from "./providers";
import { HostStore } from "./store";
import type { HostCheckpoints } from "./checkpoints";
import type { HostEmployees } from "./employees";
import type { HostAutomations } from "./automations";
import type { HostAppBridge } from "./app-bridge";
import { CONTINUE_PROMPT } from "../src/features/sessions/model/inFlight";
import { usageLimitResumeDue } from "../src/features/sessions/model/usageLimit";
import {
  AUTO_ACCOUNT,
  DEFAULT_ACCOUNT,
  carryClaudeTranscript,
  claudeConfigDir,
  type HostAccounts,
} from "./accounts";
import type { HostPush } from "./push";
import type { HostAccountLogins } from "./account-login";
import { parseRemoteAttachments, resolveAttachments } from "./attachments";
import {
  lastUserTurnBlock,
  truncateBeforeLastEditableTurn,
} from "../src/features/sessions/model/editLastTurn";

// Streamed output is written in batches. Anything a user may need to act on
// (approvals, questions, errors, completion) is written immediately.
const FLUSH_MS = 120;
const BATCHED = new Set<string>([
  "message.delta",
  "reasoning.delta",
  "tool.updated",
  "agent.step",
  "status",
]);

const text = (value: unknown, label: string, max = 128): string => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    value.includes("\0")
  )
    throw new Error(`Invalid ${label}`);
  return value;
};

function modelSettings(value: unknown): Record<string, string> {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid model settings");
  const entries = Object.entries(value);
  if (
    entries.length > 20 ||
    entries.some(
      ([key, setting]) =>
        !/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(key) ||
        typeof setting !== "string" ||
        setting.length > 128 ||
        setting.includes("\0"),
    )
  )
    throw new Error("Invalid model settings");
  return Object.fromEntries(entries) as Record<string, string>;
}

function accountField(value: unknown): { providerAccountId?: string } {
  if (value === undefined) return {};
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value))
    throw new Error("Invalid provider account");
  return { providerAccountId: value };
}

/** Claude's text when a usage window refuses the turn. */
const LIMIT_TEXT = /hit your (?:[a-z0-9-]+ )?limit|usage limit reached/i;

/** Binds a provider conversation, naming its account only when it has one. */
function bindProvider(
  provider: HostProvider,
  id: string,
  providerSessionId: string,
  cwd: string,
  account: string | undefined,
): void {
  if (account) provider.bind(id, providerSessionId, cwd, account);
  else provider.bind(id, providerSessionId, cwd);
}

/** The concrete account a session's provider conversation belongs to. */
function boundAccount(value: HostSession): string | undefined {
  const requested = value.session.providerAccountId;
  if (requested === AUTO_ACCOUNT) return value.accountInUse;
  return requested && requested !== DEFAULT_ACCOUNT ? requested : undefined;
}

export function parseCommand(input: unknown): HostCommand {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid command");
  const v = input as Record<string, unknown>;
  const commandId = text(v.commandId, "command ID");
  if (v.type === "create") {
    if (
      !isRemoteProvider(v.harness) ||
      !RUNTIME_MODES.includes(v.runtimeMode as never)
    )
      throw new Error("Invalid provider or permission mode");
    if (
      v.autoWorktreeBranch !== undefined &&
      (v.worktreeCwd === undefined ||
        typeof v.autoWorktreeBranch !== "string" ||
        !/^mc\/[a-z0-9]{8}$/.test(v.autoWorktreeBranch))
    )
      throw new Error("Invalid automatically created worktree branch");
    return {
      type: "create",
      commandId,
      projectId: text(v.projectId, "project ID"),
      ...(v.worktreeCwd !== undefined
        ? { worktreeCwd: text(v.worktreeCwd, "working copy", 4096) }
        : {}),
      ...(v.autoWorktreeBranch !== undefined
        ? { autoWorktreeBranch: v.autoWorktreeBranch as string }
        : {}),
      harness: v.harness,
      model: text(v.model, "model", 200),
      ...(v.modelSettings !== undefined
        ? { modelSettings: modelSettings(v.modelSettings) }
        : {}),
      runtimeMode: v.runtimeMode as Session["runtimeMode"],
      ...accountField(v.providerAccountId),
    };
  }
  const sessionId = text(v.sessionId, "session ID");
  if (v.type === "configure") {
    if (!RUNTIME_MODES.includes(v.runtimeMode as never))
      throw new Error("Invalid permission mode");
    return {
      type: "configure",
      commandId,
      sessionId,
      model: text(v.model, "model", 200),
      modelSettings: modelSettings(v.modelSettings),
      runtimeMode: v.runtimeMode as Session["runtimeMode"],
      ...accountField(v.providerAccountId),
    };
  }
  if (v.type === "compact") return { type: "compact", commandId, sessionId };
  if (v.type === "send" || v.type === "draft") {
    const attachments = parseRemoteAttachments(v.attachments);
    if (
      typeof v.text !== "string" ||
      v.text.length > 256_000 ||
      v.text.includes("\0") ||
      (!v.text.trim() &&
        attachments.length === 0 &&
        !(v.type === "send" && v.draftBlockId !== undefined))
    )
      throw new Error("Invalid prompt");
    if (
      v.type === "send" &&
      v.intent !== undefined &&
      !["default", "plan", "build"].includes(String(v.intent))
    )
      throw new Error("Invalid turn intent");
    if (
      v.planBlockId !== undefined &&
      (v.type !== "send" || v.intent !== "build")
    )
      throw new Error("Invalid plan build");
    return {
      type: v.type,
      commandId,
      sessionId,
      text: v.text,
      ...(attachments.length ? { attachments } : {}),
      ...(v.type === "send" && v.intent
        ? { intent: v.intent as "default" | "plan" | "build" }
        : {}),
      ...(v.type === "send" && v.draftBlockId !== undefined
        ? { draftBlockId: text(v.draftBlockId, "draft block ID") }
        : {}),
      ...(v.type === "send" && v.planBlockId !== undefined
        ? { planBlockId: text(v.planBlockId, "plan block ID") }
        : {}),
      ...(v.type === "send" && v.prompt !== undefined
        ? { prompt: providerPrompt(v.prompt) }
        : {}),
      ...(v.type === "send" && v.appAccess === true ? { appAccess: true } : {}),
    } as HostCommand;
  }
  if (v.type === "queue" || v.type === "editLast") {
    const attachments = parseRemoteAttachments(v.attachments);
    const typed = promptText(v.text);
    if (!typed.trim() && attachments.length === 0) throw new Error("Invalid prompt");
    if (v.type === "queue" && v.intent !== undefined && v.intent !== "default" && v.intent !== "plan")
      throw new Error("Invalid turn intent");
    return {
      type: v.type,
      commandId,
      sessionId,
      text: typed,
      ...(attachments.length ? { attachments } : {}),
      ...(v.type === "queue" && v.intent ? { intent: v.intent as "default" | "plan" } : {}),
      ...(v.prompt !== undefined ? { prompt: providerPrompt(v.prompt) } : {}),
      ...(v.type === "queue" && v.appAccess === true ? { appAccess: true } : {}),
    } as HostCommand;
  }
  if (v.type === "queueEdit")
    return {
      type: "queueEdit",
      commandId,
      sessionId,
      messageId: text(v.messageId, "message ID"),
      text: promptText(v.text),
      ...(v.prompt !== undefined ? { prompt: providerPrompt(v.prompt) } : {}),
    };
  if (v.type === "queueRemove" || v.type === "queueSteer")
    return {
      type: v.type,
      commandId,
      sessionId,
      messageId: text(v.messageId, "message ID"),
    };
  if (v.type === "queueResume") return { type: "queueResume", commandId, sessionId };
  if (v.type === "removeDraft")
    return {
      type: "removeDraft",
      commandId,
      sessionId,
      draftBlockId: text(v.draftBlockId, "draft block ID"),
    };
  const runId = text(v.runId, "run ID");
  if (v.type === "cancel")
    return { type: "cancel", commandId, sessionId, runId };
  if (!Number.isSafeInteger(v.requestId) || Number(v.requestId) < 0)
    throw new Error("Invalid request ID");
  const requestId = Number(v.requestId);
  if (v.type === "approve" && (v.decision === "allow" || v.decision === "deny"))
    return {
      type: "approve",
      commandId,
      sessionId,
      runId,
      requestId,
      decision: v.decision,
    };
  if (v.type === "answer") {
    const reply = v.reply as
      { kind?: string; answers?: unknown; custom?: unknown } | undefined;
    if (reply?.kind === "skipped")
      return {
        type: "answer",
        commandId,
        sessionId,
        runId,
        requestId,
        reply: { kind: "skipped" },
      };
    if (
      reply?.kind === "answered" &&
      reply.answers &&
      typeof reply.answers === "object" &&
      !Array.isArray(reply.answers)
    ) {
      const entries = Object.entries(reply.answers);
      if (
        entries.length > 50 ||
        entries.some(
          ([key, value]) =>
            key.length > 200 ||
            !Array.isArray(value) ||
            value.length > 50 ||
            value.some((x) => typeof x !== "string" || x.length > 10_000),
        )
      )
        throw new Error("Invalid question answers");
      if (
        reply.custom != null &&
        (typeof reply.custom !== "object" ||
          Array.isArray(reply.custom) ||
          Object.values(reply.custom).some(
            (x) => typeof x !== "string" || x.length > 10_000,
          ))
      )
        throw new Error("Invalid custom answers");
      return {
        type: "answer",
        commandId,
        sessionId,
        runId,
        requestId,
        reply: {
          kind: "answered",
          answers: Object.fromEntries(entries),
          ...(reply.custom
            ? { custom: reply.custom as Record<string, string> }
            : {}),
        },
      };
    }
  }
  throw new Error("Unsupported command");
}

export class HostEngine {
  /** Turn review snapshots; absent in tests that do not exercise them. */
  checkpoints?: HostCheckpoints;
  employees?: HostEmployees;
  automations?: HostAutomations;
  app?: HostAppBridge;
  accountLogins?: HostAccountLogins;
  /** Notifications for the browser app. */
  push?: HostPush;

  /** Whether a turn of this session is running now. */
  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }
  private switchingProjects = new Set<string>();
  private running = new Map<
    string,
    { runId: string; done: Promise<void>; cancelled: boolean; persistenceFailed: boolean }
  >();
  /** Running sessions, including streamed events not yet written to disk. */
  private live = new Map<
    string,
    {
      value: HostSession;
      events: HarnessEvent[];
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private closing = false;
  /** Sessions waiting to continue once their usage window resets. The host
   * resumes them itself, so it happens with every desktop closed. */
  private resumeAtReset = new Set<string>();
  private resumeTimer?: ReturnType<typeof setInterval>;

  constructor(
    readonly store: HostStore,
    readonly providers: Partial<Record<RemoteProvider, HostProvider>>,
    private readonly accounts?: HostAccounts,
  ) {
    // Provider dispatch is not transactional with SQLite. Never replay a send
    // automatically after a crash; its external effects may already exist.
    for (const value of store.sessions()) {
      if (value.session.usageLimit?.resumeAtReset) this.resumeAtReset.add(value.session.id);
      if (value.status === "running") {
        this.save(
          this.settled(
            value,
            "interrupted",
            "Host restarted. This turn was interrupted; inspect its work before continuing.",
            value.updatedAt,
          ),
          { type: "interrupted" },
        );
      }
      if (value.session.providerSessionId)
        bindProvider(
          this.provider(value.session.harness),
          value.session.id,
          value.session.providerSessionId,
          value.session.cwd,
          boundAccount(value),
        );
    }
    this.resumeTimer = setInterval(() => this.resumeDue(), 30_000);
    this.resumeTimer.unref?.();
  }

  async openProject(path: string) {
    if (!isAbsolute(path) || path.includes("\0"))
      throw new Error("Choose an absolute directory path on the host");
    const cwd = await realpath(path);
    if (!(await stat(cwd)).isDirectory())
      throw new Error("Project path is not a directory");
    return this.store.addProject(cwd, basename(cwd));
  }

  async withIdleProject<T>(
    projectId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    if (this.switchingProjects.has(projectId))
      throw new Error("A branch switch is already in progress");
    if (
      this.store
        .summaries(projectId)
        .some((session) => session.status === "running")
    )
      throw new Error(
        "Wait for running host sessions before switching branches",
      );
    this.switchingProjects.add(projectId);
    try {
      return await action();
    } finally {
      this.switchingProjects.delete(projectId);
    }
  }

  private provider(id: string): HostProvider {
    const provider = this.providers[id as RemoteProvider];
    if (!provider) throw new Error(`${id} is not available on this host`);
    return provider;
  }

  private save(value: HostSession, event: unknown): HostSession {
    return this.store.transaction(() =>
      this.store.save(
        { ...value, revision: value.revision + 1, updatedAt: Date.now() },
        event,
      ),
    );
  }

  updateSession(id: string, patch: Parameters<HostStore["updateSession"]>[1]) {
    this.flush(id);
    const summary = this.store.updateSession(id, patch);
    const live = this.live.get(id);
    if (live) live.value = this.store.session(id);
    if (patch.usageLimit !== undefined) {
      if (this.store.session(id).session.usageLimit?.resumeAtReset) this.resumeAtReset.add(id);
      else this.resumeAtReset.delete(id);
      this.resumeDue();
      if (patch.usageLimit === null) this.dispatchQueued(id);
    }
    return summary;
  }

  /** Sends the continue prompt to every armed session whose window reset. */
  resumeDue(now = Date.now()): void {
    if (this.closing) return;
    for (const id of [...this.resumeAtReset]) {
      let value: HostSession;
      try {
        value = this.store.session(id);
      } catch {
        this.resumeAtReset.delete(id);
        continue;
      }
      const limit = value.session.usageLimit;
      if (!limit?.resumeAtReset) {
        this.resumeAtReset.delete(id);
        continue;
      }
      if (value.status !== "idle" || !usageLimitResumeDue(value.session, now)) continue;
      this.resumeAtReset.delete(id);
      try {
        this.command({
          type: "send",
          commandId: `resume-${id}-${limit.resetsAt}`,
          sessionId: id,
          text: CONTINUE_PROMPT,
        });
      } catch (error) {
        console.error("Could not resume a session after its usage limit:", error instanceof Error ? error.message : error);
      }
    }
  }

  /** Takes over a session a desktop recorded in its own store, so every
   * conversation lives in this host's database. Only finished state is
   * accepted: in-memory turn flags are dropped and the session starts idle. */
  importSession(raw: Record<string, unknown>): { imported: boolean } {
    const project = this.store.project(String(raw.projectId ?? ""));
    const input = raw.session;
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Invalid session");
    const session = input as Session;
    if (
      typeof session.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(session.id) ||
      !Array.isArray(session.blocks) ||
      typeof session.title !== "string" ||
      typeof session.model !== "string" ||
      !isRemoteProvider(session.harness)
    )
      throw new Error("Invalid session");
    if (session.ephemeral || session.inboxAsk)
      throw new Error("Temporary sessions are not imported");
    const time = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) && value > 0
        ? value
        : undefined;
    const updatedAt = time(raw.updatedAt) ?? Date.now();
    const {
      busy: _busy,
      turnReady: _turnReady,
      backgroundTasks: _backgroundTasks,
      editingQueuedMessageId: _editing,
      sendingQueuedMessageId: _sending,
      usageLimit: _usageLimit,
      pendingSwitch: _pendingSwitch,
      ...rest
    } = session;
    return this.store.importSession({
      session: {
        ...rest,
        cwd: session.cwd || project.cwd,
        modelSettings:
          session.modelSettings && typeof session.modelSettings === "object"
            ? session.modelSettings
            : {},
      },
      projectId: project.id,
      revision: 1,
      status: "idle",
      createdAt: time(raw.createdAt) ?? updatedAt,
      updatedAt,
      archived: raw.archived === true || undefined,
      pinned: raw.pinned === true || undefined,
    });
  }

  private flush(id: string): void {
    const live = this.live.get(id);
    if (!live) return;
    clearTimeout(live.timer);
    live.timer = undefined;
    if (!live.events.length) return;
    const events = live.events;
    live.value = this.save(live.value, { type: "events", events });
    live.events = [];
  }

  private scheduledFlush(id: string, provider: HostProvider): void {
    try {
      this.flush(id);
    } catch (error) {
      const active = this.running.get(id);
      if (active) active.persistenceFailed = true;
      console.error(
        "Session persistence failed; stopping its provider:",
        error instanceof Error ? error.message : "unknown error",
      );
      void provider.stop(id);
    }
  }

  private retrySettlement(
    id: string,
    runId: string,
    provider: HostProvider,
  ): void {
    if (this.closing || this.retryTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(id);
      void (async () => {
        try {
          await provider.stop(id);
          this.flush(id);
          const latest = this.store.session(id);
          if (latest.runId === runId && latest.status === "running")
            this.save(
              this.settled(
                latest,
                "interrupted",
                "Session storage failed during this turn. Inspect its work before continuing.",
                latest.updatedAt,
              ),
              { type: "interrupted", reason: "persistence failure" },
            );
          this.live.delete(id);
          this.running.delete(id);
          if (latest.session.providerSessionId)
            bindProvider(
              provider,
              id,
              latest.session.providerSessionId,
              latest.session.cwd,
              boundAccount(latest),
            );
        } catch (error) {
          console.error(
            "Retrying session persistence:",
            error instanceof Error ? error.message : "unknown error",
          );
          this.retrySettlement(id, runId, provider);
        }
      })();
    }, 1_000);
    timer.unref?.();
    this.retryTimers.set(id, timer);
  }

  command(raw: unknown): CommandReceipt {
    if (this.closing) throw new Error("Host is stopping");
    const command = parseCommand(raw);
    const signature = createHash("sha256")
      .update(JSON.stringify(command))
      .digest("hex");
    const previous = this.store.receipt(command.commandId, signature);
    if (previous) return previous;
    // Commands apply to the latest state, including batched stream output.
    if (command.type !== "create") this.flush(command.sessionId);
    if ((command.type === "send" || command.type === "queue") && command.appAccess)
      this.app?.enable(command.sessionId);
    if (command.type === "queue" && this.canSendNow(command.sessionId))
      return this.command({
        type: "send",
        commandId: command.commandId,
        sessionId: command.sessionId,
        text: command.text,
        ...(command.attachments ? { attachments: command.attachments } : {}),
        ...(command.intent ? { intent: command.intent } : {}),
        ...(command.prompt ? { prompt: command.prompt } : {}),
      });
    let effect: ((saved: HostSession) => void) | undefined;
    const { receipt, saved } = this.store.transaction(() => {
      let value: HostSession;
      if (command.type === "create") {
        const project = this.store.project(command.projectId);
        if (this.switchingProjects.has(project.id))
          throw new Error("Wait for the branch switch to finish");
        this.provider(command.harness);
        this.checkAccount(command.harness, command.providerAccountId);
        const cwd = resolveHostWorktree(project.cwd, command.worktreeCwd);
        const now = Date.now();
        value = {
          projectId: project.id,
          autoWorktreeBranch: command.autoWorktreeBranch,
          revision: 0,
          status: "idle",
          createdAt: now,
          updatedAt: now,
          session: {
            id: randomUUID(),
            cwd,
            harness: command.harness,
            model: command.model,
            runtimeMode: command.runtimeMode,
            modelSettings: command.modelSettings ?? {},
            ...(command.providerAccountId
              ? { providerAccountId: command.providerAccountId }
              : {}),
            title: "New remote session",
            ...(command.autoWorktreeBranch
              ? { branch: command.autoWorktreeBranch, worktreeCwd: cwd }
              : {}),
            blocks: [],
          },
        };
      } else {
        value = this.store.session(command.sessionId);
        if (
          (command.type === "send" || command.type === "compact") &&
          this.switchingProjects.has(value.projectId)
        )
          throw new Error("Wait for the branch switch to finish");
        const provider = this.provider(value.session.harness);
        if (command.type === "configure") {
          if (value.status === "running")
            throw new Error(
              "Wait for the current turn before changing settings",
            );
          this.checkAccount(value.session.harness, command.providerAccountId);
          const before = boundAccount(value);
          value = {
            ...value,
            session: {
              ...value.session,
              model: command.model,
              modelSettings: command.modelSettings,
              runtimeMode: command.runtimeMode,
              ...(command.providerAccountId
                ? { providerAccountId: command.providerAccountId }
                : {}),
            },
          };
          if (command.providerAccountId && command.providerAccountId !== AUTO_ACCOUNT)
            value = this.moveToAccount(value, provider, before);
        } else if (command.type === "draft") {
          if (
            value.status === "running" ||
            value.session.blocks.some((block) => block.draft)
          )
            throw new Error("This session cannot save another draft right now");
          const attachments = resolveAttachments(
            this.store,
            command.attachments ?? [],
          );
          value = {
            ...value,
            session: {
              ...value.session,
              title: value.session.blocks.length
                ? value.session.title
                : titleFromPrompt(
                    command.text,
                    value.session.harness,
                    attachments,
                  ),
              blocks: [
                ...value.session.blocks,
                {
                  id: command.commandId,
                  role: "user",
                  text: command.text,
                  ...(attachments.length ? { attachments } : {}),
                  draft: true,
                },
              ],
            },
          };
        } else if (command.type === "removeDraft") {
          const draft = value.session.blocks.find(
            (block) => block.id === command.draftBlockId && block.draft,
          );
          if (!draft) throw new Error("Draft not found");
          value = {
            ...value,
            session: {
              ...value.session,
              blocks: value.session.blocks.filter(
                (block) => block.id !== draft.id,
              ),
            },
          };
        } else if (command.type === "queue") {
          const attachments = resolveAttachments(
            this.store,
            command.attachments ?? [],
          );
          value = {
            ...value,
            session: {
              ...value.session,
              queuedMessages: [
                ...(value.session.queuedMessages ?? []),
                {
                  id: command.commandId,
                  text: command.text,
                  attachments,
                  ...(command.attachments?.length
                    ? { attachmentRefs: command.attachments }
                    : {}),
                  ...(command.intent === "plan" ? { intent: "plan" as const } : {}),
                  ...(command.prompt ? { prompt: command.prompt } : {}),
                },
              ],
            },
          };
          effect = () => this.dispatchQueued(command.sessionId);
        } else if (command.type === "queueEdit") {
          const queued = value.session.queuedMessages ?? [];
          if (!queued.some((message) => message.id === command.messageId))
            throw new Error("Queued message not found");
          value = {
            ...value,
            session: {
              ...value.session,
              queuedMessages: queued.map((message) =>
                message.id === command.messageId
                  ? {
                      ...message,
                      text: command.text,
                      prompt: command.prompt,
                      error: undefined,
                    }
                  : message,
              ),
            },
          };
        } else if (command.type === "queueRemove") {
          const queued = (value.session.queuedMessages ?? []).filter(
            (message) => message.id !== command.messageId,
          );
          value = {
            ...value,
            session: {
              ...value.session,
              queuedMessages: queued.length ? queued : undefined,
              queueStatus: queued.length ? value.session.queueStatus : undefined,
            },
          };
        } else if (command.type === "queueResume") {
          value = {
            ...value,
            session: {
              ...value.session,
              queueStatus: undefined,
              queuedMessages: value.session.queuedMessages?.map((message) => ({
                ...message,
                error: undefined,
              })),
            },
          };
          effect = () => this.dispatchQueued(command.sessionId);
        } else if (command.type === "queueSteer") {
          if (value.status !== "running")
            throw new Error("Nothing is running to steer");
          if (!provider.steer)
            throw new Error("This provider cannot take a message during a turn");
          const message = value.session.queuedMessages?.find(
            (entry) => entry.id === command.messageId,
          );
          if (!message) throw new Error("Queued message not found");
          if (message.intent === "plan")
            throw new Error("A plan request waits for the current turn");
          const queued = (value.session.queuedMessages ?? []).filter(
            (entry) => entry !== message,
          );
          value = {
            ...value,
            session: {
              ...value.session,
              queuedMessages: queued.length ? queued : undefined,
              blocks: [
                ...value.session.blocks,
                {
                  id: message.id,
                  role: "user",
                  text: message.text,
                  ...(message.attachments.length
                    ? { attachments: message.attachments }
                    : {}),
                  startedAt: Date.now(),
                },
              ],
            },
          };
          const session = value.session;
          effect = () =>
            void provider
              .steer!({
                sessionId: session.id,
                cwd: session.cwd,
                model: session.model,
                modelSettings: session.modelSettings,
                text: message.prompt ?? message.text,
                attachments: withImageData(message.attachments),
              })
              .catch((reason) =>
                this.note(
                  session.id,
                  `Could not add the message to the running turn: ${reason instanceof Error ? reason.message : String(reason)}`,
                ),
              );
        } else if (command.type === "editLast") {
          if (value.status === "running")
            throw new Error("Wait for the current turn before editing");
          if (!provider.rewind)
            throw new Error("This provider cannot edit its last message");
          const last = lastUserTurnBlock(value.session.blocks as Session["blocks"]);
          if (!last) throw new Error("There is no message to edit");
          const session = value.session;
          effect = () => void this.resendEdited(command, session, provider, last.providerTurnId);
        } else if (command.type === "send" || command.type === "compact") {
          if (value.status === "running")
            throw new Error("This session is already running");
          if (command.type === "compact" && !provider.compact)
            throw new Error(
              "Context compaction is unavailable for this provider",
            );
          const draft =
            command.type === "send" && command.draftBlockId
              ? value.session.blocks.find(
                  (block) => block.id === command.draftBlockId && block.draft,
                )
              : undefined;
          if (command.type === "send" && command.draftBlockId && !draft)
            throw new Error("Draft not found");
          const plan =
            command.type === "send" && command.planBlockId
              ? value.session.blocks.find(
                  (block) =>
                    block.id === command.planBlockId && block.role === "plan",
                )
              : undefined;
          if (
            command.type === "send" &&
            command.planBlockId &&
            (!plan ||
              !plan.text.trim() ||
              plan.streaming ||
              plan.plan?.status === "building" ||
              plan.plan?.status === "built")
          )
            throw new Error("Plan is not ready to build");
          const attachments =
            command.type === "send"
              ? (draft?.attachments ??
                resolveAttachments(this.store, command.attachments ?? []))
              : [];
          const runId = randomUUID();
          const firstTurn =
            command.type === "send" &&
            !value.session.blocks.some((block) => !block.draft);
          const placeholderTitle =
            value.session.title === "New remote session" ||
            canReplaceSessionTitle(
              value.session.title,
              value.session.harness,
              HARNESS_LABEL[value.session.harness],
            );
          const model = resolveModel(
            value.session.harness,
            value.session.model,
          );
          value = {
            ...value,
            status: "running",
            runId,
            session: {
              ...value.session,
              busy: true,
              pendingQuestion: undefined,
              // A new turn supersedes the limit notice, as it does locally.
              usageLimit: undefined,
              title:
                firstTurn && placeholderTitle
                  ? titleFromPrompt(
                      command.text,
                      value.session.harness,
                      attachments,
                    )
                  : value.session.title,
              queuedMessages: dropQueued(value.session.queuedMessages, command.commandId),
              blocks: [
                ...value.session.blocks
                  .filter((block) => !block.draft)
                  .map((block) =>
                    block === plan
                      ? {
                          ...block,
                          plan: {
                            ...(block.plan ?? { status: "ready" as const }),
                            status: "building" as const,
                            approvedText: block.text,
                          },
                        }
                      : block,
                  ),
                {
                  id: command.commandId,
                  role: "user",
                  text: command.type === "compact" ? "/compact" : command.text,
                  ...(attachments.length ? { attachments } : {}),
                  startedAt: Date.now(),
                  turnModel: {
                    harness: value.session.harness,
                    id: value.session.model,
                    name:
                      model.id === value.session.model
                        ? model.name
                        : value.session.model.replace(/^[^:]+:/, ""),
                  },
                },
              ],
            },
          };
          effect = (saved) => {
            this.run(
              saved,
              command.type === "compact"
                ? null
                : (command.prompt ?? command.text),
              command.type === "send" ? command.intent : undefined,
              attachments,
            );
            if (firstTurn && command.type === "send") {
              this.generateFirstTurnNames(
                saved,
                command.text,
                placeholderTitle,
              );
            }
          };
        } else {
          if (value.runId !== command.runId || value.status !== "running")
            throw new Error(
              "This request belongs to a finished or replaced turn",
            );
          if (command.type === "cancel") {
            effect = () => {
              const active = this.running.get(command.sessionId);
              if (active) active.cancelled = true;
              void provider
                .cancel(command.sessionId)
                .catch(() => provider.stop(command.sessionId));
            };
          } else if (command.type === "approve") {
            const pending = value.session.blocks.some(
              (block) =>
                block.approval?.requestId === command.requestId &&
                !block.approval.decided,
            );
            if (!pending) throw new Error("Approval is already resolved");
            value = {
              ...value,
              session: applyHarnessEvent(value.session, {
                type: "approval.resolved",
                requestId: command.requestId,
                decision: command.decision,
              }),
            };
            effect = () =>
              provider.approve(
                command.sessionId,
                command.requestId,
                command.decision,
              );
          } else {
            if (value.session.pendingQuestion?.requestId !== command.requestId)
              throw new Error("Question is already resolved");
            value = {
              ...value,
              session: { ...value.session, pendingQuestion: undefined },
            };
            effect = () =>
              provider.answer(
                command.sessionId,
                command.requestId,
                command.reply,
              );
          }
        }
      }
      const saved = this.store.save(
        {
          ...value,
          revision: value.revision + 1,
          // Creation already initialized both timestamps from the same clock read.
          updatedAt: command.type === "create" ? value.updatedAt : Date.now(),
        },
        { type: "command", command },
      );
      const result = {
        commandId: command.commandId,
        sessionId: saved.session.id,
        revision: saved.revision,
      };
      this.store.recordReceipt(signature, result);
      return { receipt: result, saved };
    });
    const live = this.live.get(saved.session.id);
    if (live) live.value = saved;
    // A receipt means durable host acceptance, not provider completion.
    effect?.(saved);
    return receipt;
  }

  private generateFirstTurnNames(
    value: HostSession,
    message: string,
    generateTitle: boolean,
  ): void {
    const provider = this.provider(value.session.harness);
    const { id, cwd, harness, title } = value.session;
    if (generateTitle && provider.generateTitle) {
      void provider
        .generateTitle({ sessionId: id, cwd, message })
        .then((generated) => {
          if (!generated) return;
          this.flush(id);
          const current = this.store.session(id);
          if (current.session.title !== title) return;
          const saved = this.save(
            {
              ...current,
              session: {
                ...current.session,
                title: formatSessionTitle(harness, generated.title),
              },
            },
            { type: "session.generatedTitle" },
          );
          const live = this.live.get(id);
          if (live) live.value = saved;
        })
        .catch((error) =>
          console.debug("[monocode] remote session title", error),
        );
    }
    const temporary = value.autoWorktreeBranch;
    if (temporary && provider.generateBranchName) {
      void provider
        .generateBranchName(cwd, message)
        .then(async (fragment) => {
          const branch = fragment ? namedWorktreeBranch(fragment) : null;
          if (!branch) return;
          // A title/branch request may finish after the conversation was deleted.
          const currentBeforeRename = this.store.session(id);
          if (currentBeforeRename.autoWorktreeBranch !== temporary) return;
          const project = this.store.project(value.projectId);
          await renameHostWorktreeBranch(project.cwd, cwd, temporary, branch,
            () => this.store.session(id).autoWorktreeBranch === temporary);
          this.flush(id);
          const current = this.store.session(id);
          const saved = this.save(
            {
              ...current,
              autoWorktreeBranch: undefined,
              session: { ...current.session, branch },
            },
            { type: "session.generatedBranch", branch },
          );
          const live = this.live.get(id);
          if (live) live.value = saved;
        })
        .catch((error) =>
          console.debug("[monocode] remote worktree branch", error),
        );
    }
  }

  /** Host sessions working inside `path`, refused while one is running. */
  worktreeSessions(path: string): string[] {
    const inside = (cwd: string) =>
      cwd === path || cwd.startsWith(path.endsWith("/") ? path : `${path}/`);
    const sessions = this.store.sessions().filter((value) => inside(value.session.cwd));
    if (sessions.some((value) => value.status === "running"))
      throw new Error("Stop the sessions running in this worktree first.");
    return sessions.map((value) => value.session.id);
  }

  /** After a worktree is gone, its sessions either go or move to the project. */
  releaseWorktreeSessions(ids: readonly string[], projectCwd: string, keep: boolean): void {
    for (const id of ids) {
      if (!keep) {
        this.store.deleteSession(id);
        continue;
      }
      this.patch(
        id,
        (session) => ({
          ...session,
          cwd: projectCwd,
          worktreeCwd: undefined,
          branch: undefined,
          blocks: [
            ...session.blocks,
            {
              id: randomUUID(),
              role: "system",
              text: "Its worktree was deleted. This conversation now works in the project folder.",
              streaming: false,
            },
          ],
        }),
        { type: "worktree.removed" },
      );
    }
  }

  /** A stopped turn pauses the queue, as locally; a finished one sends on. */
  private afterTurn(id: string, cancelled: boolean): void {
    if (this.closing) return;
    const value = this.store.session(id);
    if (!value.session.queuedMessages?.length) return;
    if (cancelled) {
      this.patch(id, (session) => ({ ...session, queueStatus: "paused" }), {
        type: "queue.paused",
      });
      return;
    }
    setTimeout(() => this.dispatchQueued(id), 0);
  }

  private canSendNow(id: string): boolean {
    const value = this.store.session(id);
    return (
      value.status !== "running" &&
      !value.session.usageLimit &&
      value.session.queueStatus !== "paused" &&
      !value.session.queuedMessages?.length &&
      !this.switchingProjects.has(value.projectId)
    );
  }

  /** Sends the queue's head once the session is free, as the desktop does. */
  private dispatchQueued(id: string): void {
    if (this.closing) return;
    const value = this.store.session(id);
    const head = value.session.queuedMessages?.[0];
    if (
      !head ||
      value.status === "running" ||
      value.session.usageLimit ||
      value.session.queueStatus === "paused" ||
      this.switchingProjects.has(value.projectId)
    )
      return;
    try {
      this.command({
        type: "send",
        commandId: queuedSendId(head.id),
        sessionId: id,
        text: head.text,
        ...(head.attachmentRefs?.length ? { attachments: head.attachmentRefs } : {}),
        ...(head.intent === "plan" ? { intent: "plan" } : {}),
        ...(head.prompt ? { prompt: head.prompt } : {}),
      });
    } catch (reason) {
      const error = reason instanceof Error ? reason.message : String(reason);
      this.patch(
        id,
        (session) => ({
          ...session,
          queueStatus: "paused",
          queuedMessages: session.queuedMessages?.map((message) =>
            message.id === head.id ? { ...message, error } : message,
          ),
        }),
        { type: "queue.failed", messageId: head.id },
      );
    }
  }

  private async resendEdited(
    command: Extract<HostCommand, { type: "editLast" }>,
    session: HostSession["session"],
    provider: HostProvider,
    providerTurnId: string | undefined,
  ): Promise<void> {
    try {
      await provider.rewind!({
        sessionId: session.id,
        cwd: session.cwd,
        model: session.model,
        modelSettings: session.modelSettings,
        runtimeMode: session.runtimeMode,
        onEvent: () => undefined,
        ...(providerTurnId ? { providerTurnId } : {}),
      });
      this.patch(
        session.id,
        (latest) => ({
          ...latest,
          blocks: truncateBeforeLastEditableTurn(latest as Session),
        }),
        { type: "turn.rewound" },
      );
      this.command({
        type: "send",
        commandId: `${command.commandId}:send`,
        sessionId: session.id,
        text: command.text,
        ...(command.attachments ? { attachments: command.attachments } : {}),
        ...(command.prompt ? { prompt: command.prompt } : {}),
      });
    } catch (reason) {
      this.note(
        session.id,
        `Could not edit the last message: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    }
  }

  private note(id: string, text: string): void {
    this.patch(
      id,
      (session) => ({
        ...session,
        blocks: [
          ...session.blocks,
          { id: randomUUID(), role: "system", text, streaming: false },
        ],
      }),
      { type: "note" },
    );
  }

  /** Applies a host-initiated change to the latest saved state. */
  private patch(
    id: string,
    change: (session: HostSession["session"]) => HostSession["session"],
    event: unknown,
  ): void {
    this.flush(id);
    const latest = this.store.session(id);
    const saved = this.save({ ...latest, session: change(latest.session) }, event);
    const live = this.live.get(id);
    if (live) live.value = saved;
  }

  accountSummaries() {
    return this.accounts?.summaries() ?? [];
  }

  /** Puts an account in the balanced pool or takes it out; the summaries after. */
  setAccountBalanced(params: Record<string, unknown>) {
    if (!this.accounts) throw new Error("Named provider accounts are not configured on this host");
    this.accounts.setBalanced(String(params.accountId ?? ""), params.balanced === true);
    return this.accountSummaries();
  }

  /** The summaries after reading every account's usage afresh. */
  async refreshAccountUsage() {
    await this.accounts?.refreshUsage();
    return this.accountSummaries();
  }

  private checkAccount(harness: string, id: string | undefined): void {
    if (!id || id === DEFAULT_ACCOUNT) return;
    if (id === AUTO_ACCOUNT) {
      if (!this.accounts?.pool(harness).length)
        throw new Error(`No balanced ${harness} accounts are configured on this host`);
      return;
    }
    if (!this.accounts) throw new Error("Named provider accounts are not configured on this host");
    this.accounts.find(harness, id);
  }

  /** The concrete account this turn runs on. A balanced conversation keeps
   * its account until that account is limited, then takes the best one. */
  private accountForRun(id: string): string | undefined {
    const live = this.live.get(id);
    if (!live) return undefined;
    const value = live.value;
    const requested = value.session.providerAccountId;
    if (!requested || requested === DEFAULT_ACCOUNT) return undefined;
    if (requested !== AUTO_ACCOUNT || !this.accounts) return requested;
    const harness = value.session.harness;
    const pool = this.accounts.pool(harness);
    const current = value.accountInUse;
    const blockedUntil = current ? this.accounts.usage()[current]?.blockedUntil : undefined;
    let chosen =
      current && pool.some((account) => account.id === current) && !(blockedUntil && blockedUntil > Date.now())
        ? current
        : this.accounts.pick(harness)?.account.id;
    // Codex keeps its threads per profile and has no carry-over: an existing
    // Codex conversation stays where it started.
    if (harness !== "claude" && current && value.session.providerSessionId) chosen = current;
    if (chosen && chosen !== current)
      this.useAccount(id, this.provider(harness), current, chosen);
    return chosen;
  }

  /** When the first account of a balanced conversation's pool reopens. */
  private soonestReset(id: string): number | undefined {
    const harness = this.live.get(id)?.value.session.harness;
    if (!harness || !this.accounts) return undefined;
    const usage = this.accounts.usage();
    const now = Date.now();
    const resets = this.accounts
      .pool(harness)
      .map((account) => usage[account.id]?.blockedUntil)
      .filter((until): until is number => typeof until === "number" && until > now);
    return resets.length ? Math.min(...resets) : undefined;
  }

  /** The account after a limited one, or nothing when all are limited. */
  private nextAccount(
    id: string,
    limitedId: string,
    limited: { resetsAt?: number },
    tried: string[],
  ): string | undefined {
    const value = this.live.get(id)?.value;
    if (!this.accounts || value?.session.providerAccountId !== AUTO_ACCOUNT) return undefined;
    if (value.session.harness !== "claude") return undefined;
    this.accounts.markBlocked(limitedId, limited.resetsAt);
    tried.push(limitedId);
    const next = this.accounts.pick(value.session.harness, tried);
    return next?.free ? next.account.id : undefined;
  }

  /**
   * A conversation switched to a named account (or the default one) by hand
   * continues there: its Claude transcript is copied into that profile, as a
   * balanced conversation's is when it changes account.
   */
  private moveToAccount(
    value: HostSession,
    provider: HostProvider,
    before: string | undefined,
  ): HostSession {
    const after = boundAccount(value);
    const { session } = value;
    if (after !== before && session.harness === "claude" && session.providerSessionId) {
      const dir = (id: string | undefined) =>
        claudeConfigDir(id && this.accounts ? this.accounts.find("claude", id) : undefined);
      carryClaudeTranscript(dir(before), dir(after), session.providerSessionId);
      bindProvider(provider, session.id, session.providerSessionId, session.cwd, after);
    }
    return { ...value, accountInUse: after ?? DEFAULT_ACCOUNT };
  }

  /** Moves a conversation's provider identity onto another account. */
  private useAccount(
    id: string,
    provider: HostProvider,
    fromId: string | undefined,
    toId: string,
  ): void {
    const live = this.live.get(id);
    if (!live) return;
    const { session } = live.value;
    if (session.providerSessionId && session.harness === "claude" && this.accounts) {
      const from = fromId ? this.accounts.find("claude", fromId) : undefined;
      const to = this.accounts.find("claude", toId);
      carryClaudeTranscript(claudeConfigDir(from), claudeConfigDir(to), session.providerSessionId);
      provider.bind(id, session.providerSessionId, session.cwd, toId);
    }
    live.value = this.save(
      { ...live.value, accountInUse: toId },
      { type: "account.selected", from: fromId, to: toId },
    );
  }

  /**
   * Routes one provider attempt's events. On a balanced conversation the
   * limit notice (its synthetic message, error and `usage.limited`) is held
   * back until the engine knows whether another account takes the turn.
   */
  private attempt(id: string, runId: string, accountId: string | undefined) {
    const balanced =
      this.live.get(id)?.value.session.providerAccountId === AUTO_ACCOUNT;
    const held: HarnessEvent[] = [];
    let full: number | undefined;
    const state: {
      limited?: { resetsAt?: number };
      onEvent: (event: HarnessEvent) => void;
      release: () => void;
      discard: () => void;
    } = {
      onEvent: (incoming) => {
        let event = incoming;
        if (event.type === "rate.limits") {
          full = [event.fiveHour, event.sevenDay]
            .filter((window) => window && window.used >= 100 && window.resetsAt)
            .reduce((latest, window) => Math.max(latest ?? 0, window!.resetsAt!), full);
          if (accountId && this.accounts)
            this.accounts.recordUsage(accountId, {
              fiveHour: event.fiveHour,
              sevenDay: event.sevenDay,
            });
          return;
        }
        // Claude does not always say when a refused window reopens; the
        // window that filled up during this attempt does.
        if (event.type === "usage.limited" && event.resetsAt == null && full)
          event = { ...event, resetsAt: full };
        if (event.type === "usage.limited") {
          state.limited = { resetsAt: event.resetsAt };
          if (accountId && this.accounts) this.accounts.markBlocked(accountId, event.resetsAt);
        }
        if (
          balanced &&
          (event.type === "usage.limited" ||
            ((event.type === "message.delta" || event.type === "session.error") &&
              LIMIT_TEXT.test(event.type === "message.delta" ? event.text : event.message)))
        ) {
          held.push(event);
          return;
        }
        this.event(id, runId, event);
      },
      release: () => {
        // Every pooled account refused the turn: the conversation can go on
        // as soon as the first of them reopens, not when the last one tried does.
        const soonest = balanced ? this.soonestReset(id) : undefined;
        for (const event of held.splice(0))
          this.event(
            id,
            runId,
            event.type === "usage.limited" && soonest ? { ...event, resetsAt: soonest } : event,
          );
      },
      discard: () => {
        held.length = 0;
      },
    };
    return state;
  }

  private run(
    value: HostSession,
    prompt: string | null,
    intent?: "default" | "plan" | "build",
    attachments: Session["blocks"][number]["attachments"] = [],
  ): void {
    const { session, runId } = value;
    const provider = this.provider(session.harness);
    const active = { runId: runId!, done: Promise.resolve(), cancelled: false, persistenceFailed: false };
    this.running.set(session.id, active);
    this.live.set(session.id, { value, events: [] });
    active.done = Promise.resolve()
      .then(async () => {
        let error: string | undefined;
        if (prompt !== null)
          await this.checkpoints?.begin(session.id, session.cwd).catch(() => undefined);
        try {
          const tried: string[] = [];
          while (!this.closing && !active.cancelled) {
            const accountId = this.accountForRun(session.id);
            const attempt = this.attempt(session.id, runId!, accountId);
            const input: HarnessSessionInput = {
              sessionId: session.id,
              cwd: session.cwd,
              model: session.model,
              modelSettings: session.modelSettings,
              runtimeMode: session.runtimeMode,
              intent,
              ...(accountId ? { providerAccountId: accountId } : {}),
              onEvent: attempt.onEvent,
            };
            if (prompt === null) await provider.compact!(input);
            else
              await provider.send({
                ...input,
                text: prompt,
                attachments: attachments?.map((file) =>
                  isVisionImage(file.mimeType) &&
                  file.path &&
                  file.size <= 20 * 1024 * 1024
                    ? {
                        ...file,
                        data: readFileSync(file.path).toString("base64"),
                      }
                    : file,
                ),
              });
            const next =
              attempt.limited && accountId && !active.cancelled && !this.closing
                ? this.nextAccount(session.id, accountId, attempt.limited, tried)
                : undefined;
            if (!next) {
              attempt.release();
              break;
            }
            // The refused turn never reached the transcript: run it again on
            // the next account, the conversation carried over.
            attempt.discard();
            await provider.stop(session.id);
            this.flush(session.id);
            this.useAccount(session.id, provider, accountId, next);
          }
        } catch (reason) {
          error = reason instanceof Error ? reason.message : String(reason);
        }
        // Keep the session running until the old process has stopped. Otherwise
        // a follow-up can race cleanup and have its newly spawned child killed.
        await provider.stop(session.id);
        if (prompt !== null)
          await this.checkpoints?.finish(session.id).catch(() => undefined);
        this.flush(session.id);
        this.live.delete(session.id);
        const latest = this.store.session(session.id);
        if (latest.runId === runId) {
          const message = this.closing
            ? "Host stopped. This turn was interrupted."
            : active.persistenceFailed
              ? "Session storage failed during this turn. Inspect its work before continuing."
              : active.cancelled
              ? "Stopped by you."
              : error;
          this.save(
            this.settled(
              latest,
              this.closing || active.persistenceFailed ? "interrupted" : "idle",
              message,
            ),
            { type: "settled", error, cancelled: active.cancelled },
          );
        }
        this.running.delete(session.id);
        if (latest.runId === runId) this.afterTurn(session.id, active.cancelled);
        // stop/forget releases callbacks and native resources; bind only retained
        // provider conversation identity for an explicit future follow-up.
        const persistedValue = this.store.session(session.id);
        const persisted = persistedValue.session;
        if (persisted.providerSessionId)
          bindProvider(
            provider,
            session.id,
            persisted.providerSessionId,
            persisted.cwd,
            boundAccount(persistedValue),
          );
      })
      .catch((error) => {
        clearTimeout(this.live.get(session.id)?.timer);
        console.error(
          "Session persistence failed; stopping its provider:",
          error instanceof Error ? error.message : "unknown error",
        );
        void provider.stop(session.id);
        this.retrySettlement(session.id, runId!, provider);
      });
  }

  private event(id: string, runId: string, event: HarnessEvent): void {
    const live = this.live.get(id);
    if (!live || live.value.runId !== runId || live.value.status !== "running")
      return;
    const session = applyHarnessEvent(live.value.session, event);
    if (session === live.value.session) return;
    live.value = { ...live.value, session };
    live.events.push(event);
    if (!BATCHED.has(event.type))
      this.scheduledFlush(id, this.provider(session.harness));
    else
      live.timer ??= setTimeout(
        () => this.scheduledFlush(id, this.provider(session.harness)),
        FLUSH_MS,
      );
  }

  private settled(
    value: HostSession,
    status: "idle" | "interrupted",
    message?: string,
    endedAt = Date.now(),
  ): HostSession {
    const stopped = stopStreaming(value.session, endedAt);
    const session = {
      ...stopped,
      blocks: stopped.blocks.map((block) =>
        block.role === "plan" && block.plan?.status === "building"
          ? {
              ...block,
              plan: {
                ...block.plan,
                status:
                  status === "idle" && !message
                    ? ("built" as const)
                    : ("ready" as const),
              },
            }
          : block,
      ),
    };
    if (message)
      session.blocks.push({
        id: randomUUID(),
        role: "system",
        text: message,
        streaming: false,
      });
    return { ...value, status, session };
  }

  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.resumeTimer);
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    await Promise.all(
      [...this.running.keys()].map((id) =>
        this.provider(this.store.session(id).session.harness).stop(id),
      ),
    );
    await Promise.all([...this.running.values()].map((active) => active.done));
  }
}

function queuedSendId(id: string): string {
  return id.length > 120 ? id : `${id}:send`;
}

function dropQueued<T extends { id: string }>(
  queued: T[] | undefined,
  commandId: string,
): T[] | undefined {
  if (!queued?.length) return queued;
  const rest = queued.filter(
    (message) => message.id !== commandId && queuedSendId(message.id) !== commandId,
  );
  return rest.length ? rest : undefined;
}

function withImageData(attachments: Session["blocks"][number]["attachments"] = []) {
  return attachments.map((file) =>
    isVisionImage(file.mimeType) && file.path && file.size <= 20 * 1024 * 1024
      ? { ...file, data: readFileSync(file.path).toString("base64") }
      : file,
  );
}

function promptText(value: unknown): string {
  if (typeof value !== "string" || value.length > 256_000 || value.includes("\0"))
    throw new Error("Invalid prompt");
  return value;
}

function providerPrompt(value: unknown): string {
  if (typeof value !== "string" || value.length > 512_000 || value.includes("\0"))
    throw new Error("Invalid prompt");
  return value;
}


