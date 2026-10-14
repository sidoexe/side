import { useCallback, useEffect, useRef, useState } from "react";
import type {
  HostAccountSummary,
  HostModelCatalog,
  HostSession,
  RemoteProvider,
} from "../../src/features/connections/model/protocol";
import type { Block, RuntimeMode } from "../../src/features/sessions/model/session";
import { modelEffortSetting } from "../../src/features/sessions/model/models";
import { contextRatio } from "../../src/features/sessions/model/contextUsage";
import { harnessSupportsEditLastTurn, lastUserTurnBlock } from "../../src/features/sessions/model/editLastTurn";
import { HarnessIcon } from "../../src/features/sessions/ui/HarnessIcon";
import { command, rpc, syncSession } from "./api";
import { BranchIcon, Chip, Composer, MODES, Question, tilde, usePoll, type Outgoing } from "./ui";
import { Transcript } from "./Transcript";
import { ReviewCard } from "./workspace";

/** The open session's settings as chips: model, effort, permissions and
 * account. A change applies to the next turn, as on the desktop. */
function SessionChips({
  value,
  catalog,
  accounts,
  onConfigure,
}: {
  value: HostSession;
  catalog?: HostModelCatalog;
  accounts: HostAccountSummary[];
  onConfigure: (change: { model?: string; modelSettings?: Record<string, string>; runtimeMode?: RuntimeMode; providerAccountId?: string }) => void;
}) {
  const session = value.session;
  const harness = session.harness as RemoteProvider;
  const models = catalog?.models[harness] ?? [];
  const model = models.find((item) => item.id === session.model);
  const effort = model && modelEffortSetting(model);
  const effortValue = effort && (session.modelSettings[effort.id] ?? effort.value);
  const providerAccounts = accounts.filter((item) => item.provider === harness);
  const account = session.providerAccountId ?? "";
  return (
    <>
      <Chip
        value={session.model}
        onChange={(id) => onConfigure({ model: id })}
        disabled={!models.length}
        icon={<HarnessIcon harness={harness} className="harness" />}
        label={model?.name ?? session.model.split(":").pop() ?? session.model}
      >
        {model ? null : <option value={session.model}>{session.model}</option>}
        {models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </Chip>
      {effort ? (
        <Chip
          value={effortValue ?? ""}
          onChange={(choice) => onConfigure({ modelSettings: { ...session.modelSettings, [effort.id]: choice } })}
          label={effort.options.find((option) => option.value === effortValue)?.label ?? effortValue ?? ""}
        >
          {effort.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Chip>
      ) : null}
      <Chip value={session.runtimeMode} onChange={(mode) => onConfigure({ runtimeMode: mode })} label={MODES.find((item) => item.id === session.runtimeMode)?.label ?? session.runtimeMode}>
        {MODES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
      </Chip>
      {providerAccounts.length ? (
        <Chip
          value={account}
          onChange={(id) => onConfigure({ providerAccountId: id || "default" })}
          label={
            (providerAccounts.find((item) => item.id === account)?.label ?? "Default") +
            (account === "auto" && value.accountInUse ? ` · ${providerAccounts.find((item) => item.id === value.accountInUse)?.label ?? value.accountInUse}` : "")
          }
        >
          <option value="">Default</option>
          {providerAccounts.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </Chip>
      ) : null}
    </>
  );
}

export function SessionView({
  sessionId,
  projectId,
  branch,
  accounts,
  review,
  onError,
}: {
  sessionId: string;
  projectId: string;
  branch?: string;
  accounts: HostAccountSummary[];
  /** The host keeps a review of each turn's changes. */
  review: boolean;
  onError: (error: unknown) => void;
}) {
  const [value, setValue] = useState<HostSession>();
  const [catalog, setCatalog] = useState<HostModelCatalog>();
  const [editing, setEditing] = useState(false);
  const [seed, setSeed] = useState<{ text: string; nonce: number }>();
  const known = useRef<HostSession | undefined>(undefined);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    known.current = undefined;
    pinned.current = true;
    setValue(undefined);
    setEditing(false);
  }, [sessionId]);
  useEffect(() => {
    rpc<HostModelCatalog>("models.list", { projectId }).then(setCatalog, () => undefined);
  }, [projectId]);
  const refresh = useCallback(async () => {
    try {
      const next = await syncSession(sessionId, known.current);
      if (next !== known.current) {
        known.current = next;
        setValue(next);
      }
    } catch (error) {
      onError(error);
    }
  }, [sessionId, onError]);
  usePoll(refresh, value?.status === "running" ? 750 : 3000, [sessionId, value?.status === "running"]);
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [value]);
  const run = async (input: Parameters<typeof command>[0]) => {
    try {
      await command(input);
      await refresh();
    } catch (error) {
      onError(error);
      throw error;
    }
  };
  if (!value) return <div className="empty">Loading…</div>;
  const session = value.session;
  const running = value.status === "running";
  const editable =
    !running && harnessSupportsEditLastTurn(session.harness) ? lastUserTurnBlock(session.blocks) : undefined;
  const ratio = contextRatio(session.context);
  const send = ({ text, attachments, plan }: Outgoing) => {
    const files = attachments.length ? { attachments } : {};
    if (editing) {
      setEditing(false);
      return run({ type: "editLast", sessionId, text, ...files });
    }
    if (running || session.queuedMessages?.length)
      return run({ type: "queue", sessionId, text, ...files, ...(plan ? { intent: "plan" as const } : {}) });
    return run({ type: "send", sessionId, text, ...files, ...(plan ? { intent: "plan" as const } : {}) });
  };
  const configure = (change: Parameters<typeof SessionChips>[0]["onConfigure"] extends (c: infer C) => void ? C : never) =>
    void run({
      type: "configure",
      sessionId,
      model: change.model ?? session.model,
      modelSettings: change.modelSettings ?? session.modelSettings,
      runtimeMode: change.runtimeMode ?? session.runtimeMode,
      ...(change.providerAccountId ?? session.providerAccountId
        ? { providerAccountId: change.providerAccountId ?? session.providerAccountId }
        : {}),
    }).catch(() => undefined);
  return (
    <div className="session-view">
      <div
        className="transcript"
        ref={scroller}
        onScroll={(event) => {
          const el = event.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="transcript-inner">
          <Transcript
            blocks={session.blocks}
            cwd={session.cwd}
            running={running}
            canDecide={running && !!value.runId}
            onDecide={(requestId, decision) =>
              void run({ type: "approve", sessionId, runId: value.runId!, requestId, decision }).catch(() => undefined)
            }
            editableId={editable?.id}
            onEdit={(block: Block) => {
              setEditing(true);
              setSeed({ text: block.text, nonce: Date.now() });
            }}
            onBuild={
              running
                ? undefined
                : (block: Block) =>
                    void run({
                      type: "send",
                      sessionId,
                      text: `Build the approved plan:\n\n${block.text}`,
                      intent: "build",
                      planBlockId: block.id,
                    }).catch(() => undefined)
            }
          />
          {review && !running ? <ReviewCard sessionId={sessionId} revision={value.revision} /> : null}
          {value.status === "interrupted" ? <div className="system interrupt">Interrupted</div> : null}
          {session.usageLimit ? (
            <div className="system error">
              Usage limit reached{session.usageLimit.resetsAt ? `, resets at ${new Date(session.usageLimit.resetsAt).toLocaleString()}` : ""}.
              <div className="row">
                <button onClick={() => void run({ type: "send", sessionId, text: "Continue." }).catch(() => undefined)}>Resume</button>
                <button
                  onClick={() =>
                    void rpc("sessions.update", { projectId: value.projectId, sessionId, usageLimit: { resumeAtReset: true } }).then(refresh, onError)
                  }
                  disabled={session.usageLimit.resumeAtReset}
                >
                  {session.usageLimit.resumeAtReset ? "Resumes at reset" : "Resume at reset"}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
      <Composer
        placeholder={running ? "Queue a follow-up…" : "Ask, build…"}
        running={running}
        seed={seed}
        banner={
          editing ? (
            <>
              <span>Editing your last message</span>
              <button
                className="link"
                onClick={() => {
                  setEditing(false);
                  setSeed({ text: "", nonce: Date.now() });
                }}
              >
                Cancel
              </button>
            </>
          ) : undefined
        }
        context={
          <>
            <span className="mono ellipsis">{tilde(session.worktreeCwd ?? session.cwd)}</span>
            {branch ? <span className="mono"><BranchIcon /> {branch}</span> : null}
            {ratio != null ? (
              <span className="context-meter" title={`${session.context!.used.toLocaleString()} tokens in context`}>
                <svg viewBox="0 0 16 16" aria-hidden>
                  <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
                  <circle
                    cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2"
                    strokeDasharray={`${Math.min(1, ratio) * 37.7} 37.7`} transform="rotate(-90 8 8)" strokeLinecap="round"
                  />
                </svg>
                {Math.round(ratio * 100)}%
              </span>
            ) : null}
          </>
        }
        tools={<SessionChips value={value} catalog={catalog} accounts={accounts} onConfigure={configure} />}
        onStop={value.runId ? () => void run({ type: "cancel", sessionId, runId: value.runId! }).catch(() => undefined) : undefined}
        onSend={send}
      >
        {session.pendingQuestion && value.runId ? (
          <Question
            prompt={session.pendingQuestion}
            onReply={(reply) =>
              void run({ type: "answer", sessionId, runId: value.runId!, requestId: session.pendingQuestion!.requestId, reply }).catch(() => undefined)
            }
          />
        ) : null}
        {session.queuedMessages?.length ? (
          <div className="queue">
            {session.queuedMessages.map((message) => (
              <div key={message.id} className="queued">
                <span>{message.text}</span>
                {running ? (
                  <button className="link" onClick={() => void run({ type: "queueSteer", sessionId, messageId: message.id }).catch(() => undefined)}>
                    Send now
                  </button>
                ) : null}
                <button className="icon" aria-label="Remove" onClick={() => void run({ type: "queueRemove", sessionId, messageId: message.id }).catch(() => undefined)}>
                  <svg className="glyph" viewBox="0 0 16 16" aria-hidden><path d="M5 5l6 6M11 5l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                </button>
              </div>
            ))}
            {session.queueStatus === "paused" ? (
              <button className="link" onClick={() => void run({ type: "queueResume", sessionId }).catch(() => undefined)}>Resume queue</button>
            ) : null}
          </div>
        ) : null}
      </Composer>
    </div>
  );
}
