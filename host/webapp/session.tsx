import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { command, rpc, syncSession } from "./api";
import {
  contextRatio,
  CONTINUE_PROMPT,
  displayTitle,
  effortSetting,
  isDone,
  modelMatches,
  resetTime,
  RUNTIME_MODES,
  tilde,
  type Block,
  type HostModelCatalog,
  type HostSession,
  type UserQuestionPrompt,
} from "./model";
import { useModel } from "./store";
import { buildTranscript, TranscriptItemView } from "./transcript";
import { Chip, Composer, ContextMeter, type Outgoing } from "./composer";
import { AccountChip } from "./accounts";
import { deleteAction, sessionActions } from "./home";
import { Button, CardLabel, HarnessIcon, Icon, Menu, NavBar, Spinner, usePoll, useTicker, type MenuItem } from "./ui";

type Change = { model?: string; modelSettings?: Record<string, string>; runtimeMode?: string; providerAccountId?: string };

export function SessionView({ machineId, projectId, sessionId }: { machineId: string; projectId: string; sessionId: string }) {
  const model = useModel();
  const [value, setValue] = useState<HostSession>();
  const [catalog, setCatalog] = useState<HostModelCatalog>();
  const [editing, setEditing] = useState(false);
  const [seed, setSeed] = useState<{ text: string; nonce: number }>();
  /** Follows new output only while the end is on screen. */
  const [atEnd, setAtEnd] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const latest = useRef<HostSession>(undefined);
  const reading = useRef(false);
  const keptQuestions = useRef(new Set<number>());
  const readAgain = useRef(false);
  const summary = model.summary(machineId, projectId, sessionId);
  const title = value ? displayTitle(value.session.title, value.session.harness) : summary ? displayTitle(summary.title, summary.harness) : "Session";
  const running = value?.status === "running";
  const items = useMemo(() => (value ? buildTranscript(value.session.blocks, running) : []), [value, running]);

  /** One read at a time: two in flight can finish out of order and put an
   * older transcript back. One asked for meanwhile, such as after a send,
   * runs as soon as the first ends. */
  const refresh = async () => {
    if (reading.current) {
      readAgain.current = true;
      return;
    }
    reading.current = true;
    try {
      do {
        readAgain.current = false;
        try {
          const next = await syncSession(machineId, sessionId, latest.current);
          if (next !== latest.current) {
            latest.current = next;
            setValue(next);
          }
          model.pollSucceeded(machineId);
        } catch (error) {
          model.reportPoll(error, machineId);
        }
      } while (readAgain.current);
    } finally {
      reading.current = false;
    }
  };

  useEffect(() => {
    latest.current = undefined;
    setValue(undefined);
  }, [machineId, sessionId]);
  // Quick while a turn runs, slower when idle, as the web client does.
  usePoll(refresh, () => (latest.current?.status === "running" ? 750 : 3000), [machineId, sessionId]);
  useEffect(() => void model.refreshAccounts(machineId), [machineId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void rpc<HostModelCatalog>("models.list", { projectId }, machineId).then(setCatalog, () => undefined);
  }, [machineId, projectId]);

  // Opens at the end, and keeps to it while new output arrives.
  const last = value?.session.blocks.at(-1);
  const growth = `${value?.session.blocks.length ?? 0}-${last?.text.length ?? 0}-${items.length}`;
  const opened = useRef(false);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !value) return;
    if (!opened.current || atEnd) element.scrollTop = element.scrollHeight;
    opened.current = true;
  }, [growth]); // eslint-disable-line react-hooks/exhaustive-deps
  const toEnd = () => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });

  const run = (input: Record<string, unknown>) => {
    void command(machineId, { ...input, sessionId })
      .then(refresh)
      .catch((error: unknown) => model.report(error));
  };

  const configure = (current: HostSession, change: Change) => {
    const meta = current.session;
    const account = change.providerAccountId ?? meta.providerAccountId;
    run({
      type: "configure",
      model: change.model ?? meta.model,
      modelSettings: change.modelSettings ?? meta.modelSettings ?? {},
      runtimeMode: change.runtimeMode ?? meta.runtimeMode,
      ...(account ? { providerAccountId: account } : {}),
    });
  };

  const send = async (outgoing: Outgoing, current: HostSession) => {
    const input: Record<string, unknown> = { sessionId, text: outgoing.text };
    if (outgoing.attachments.length) input.attachments = outgoing.attachments;
    if (editing) {
      input.type = "editLast";
      setEditing(false);
    } else {
      input.type = current.status === "running" || current.session.queuedMessages?.length ? "queue" : "send";
      if (outgoing.plan) input.intent = "plan";
    }
    try {
      await command(machineId, input);
      await refresh();
    } catch (error) {
      model.report(error);
      throw error;
    }
  };

  /** `sessions.update` of the usage limit: arms or cancels the resume, or
   * clears the notice with `null`. */
  const setUsageLimit = (limit: unknown) => {
    void rpc("sessions.update", { projectId, sessionId, usageLimit: limit }, machineId)
      .catch((error: unknown) => model.report(error))
      .then(refresh);
  };

  const subtitle = [
    model.project(machineId, projectId)?.name,
    model.multi() ? model.machine(machineId)?.name : undefined,
    value ? model.modelName(machineId, value.session.harness, value.session.model) : undefined,
    summary?.branch,
    value?.accountInUse ? (model.machine(machineId)?.accounts.find((a) => a.id === value.accountInUse)?.label ?? value.accountInUse) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  const menu = (): MenuItem[] => [
    ...(summary ? sessionActions(summary, { rename: true, onArchived: () => model.pop() }) : []),
    { label: "Compact context", icon: "compress", run: () => run({ type: "compact" }) },
    ...(summary ? [deleteAction(summary)] : []),
  ];

  const editable =
    value && !running && ["pi", "omp", "codex", "opencode"].includes(value.session.harness)
      ? [...value.session.blocks].reverse().find((block) => block.role === "user")?.id
      : undefined;

  return (
    <div className="screen">
      <NavBar
        back={() => model.pop()}
        title={title}
        subtitle={subtitle}
        trailing={
          <>
            {summary && isDone(summary) ? (
              <button className="bar-button add" aria-label="Mark checked" onClick={() => void model.markChecked(summary)}>
                <Icon name="checkCircle" size={21} />
              </button>
            ) : null}
            <Menu ariaLabel="Session options" label={<Icon name="ellipsis" size={21} />} items={menu} />
          </>
        }
      />
      {value ? (
        <>
          <div
            ref={scroller}
            className="scroll transcript"
            onScroll={(event) => {
              const element = event.currentTarget;
              setAtEnd(element.scrollTop + element.clientHeight >= element.scrollHeight - 80);
            }}
          >
            {items.map((item) => (
              <TranscriptItemView
                key={item.id}
                item={item}
                cwd={value.session.cwd}
                machineId={machineId}
                sessionId={sessionId}
                canDecide={running && !!value.runId}
                onDecide={(requestId, decision) => run({ type: "approve", runId: value.runId ?? "", requestId, decision })}
                editableId={editable}
                onEdit={(block: Block) => {
                  setEditing(true);
                  setSeed({ text: block.text, nonce: (seed?.nonce ?? 0) + 1 });
                }}
                onBuild={
                  running
                    ? undefined
                    : (block: Block) => run({ type: "send", text: `Build the approved plan:\n\n${block.text}`, intent: "build", planBlockId: block.id })
                }
              />
            ))}
            {value.status === "interrupted" ? <div className="notice">Interrupted</div> : null}
            {value.session.usageLimit ? (
              <UsageLimit
                machineId={machineId}
                limit={value.session.usageLimit}
                harness={value.session.harness}
                account={value.session.providerAccountId}
                onResume={() => run({ type: "send", text: CONTINUE_PROMPT })}
                onSet={setUsageLimit}
                onAccount={(providerAccountId) => configure(value, { providerAccountId })}
              />
            ) : null}
          </div>
          <div className="bottom-inset">
            {!atEnd ? (
              <button className="jump" aria-label="Jump to the latest message" onClick={toEnd}>
                <Icon name="arrowDown" size={15} />
              </button>
            ) : null}
            {value.session.pendingQuestion && value.runId ? (
              <QuestionCard
                prompt={value.session.pendingQuestion}
                onInteract={() => {
                  // Working on it keeps it from timing out, once per question.
                  const requestId = value.session.pendingQuestion!.requestId;
                  if (!model.can("questions.keepOpen", machineId) || keptQuestions.current.has(requestId)) return;
                  keptQuestions.current.add(requestId);
                  run({ type: "questionKeepOpen", runId: value.runId, requestId });
                }}
                onReply={(reply) => run({ type: "answer", runId: value.runId, requestId: value.session.pendingQuestion!.requestId, reply })}
              />
            ) : null}
            <Queue value={value} run={run} />
            <Composer
              machineId={machineId}
              running={running}
              canPlan={model.can("sessions.plan", machineId) && !running}
              seed={seed}
              banner={editing ? "Editing your last message" : undefined}
              onCancelBanner={() => {
                setEditing(false);
                setSeed({ text: "", nonce: (seed?.nonce ?? 0) + 1 });
              }}
              onStop={value.runId ? () => run({ type: "cancel", runId: value.runId }) : undefined}
              onSend={(outgoing) => send(outgoing, value)}
              context={
                <>
                  <span className="mono ellipsis rtl"><bdi>{tilde(value.session.worktreeCwd ?? value.session.cwd)}</bdi></span>
                  {summary?.branch ? (
                    <span className="mono row-line nowrap">
                      <Icon name="branch" size={11} />
                      <span className="ellipsis">{summary.branch}</span>
                    </span>
                  ) : null}
                  <span className="spacer" />
                  {contextRatio(value.session.context) !== undefined ? <ContextMeter ratio={contextRatio(value.session.context)!} /> : null}
                </>
              }
              tools={<SessionChips machineId={machineId} value={value} catalog={catalog} onChange={(change) => configure(value, change)} />}
            />
          </div>
        </>
      ) : (
        <div className="loading">
          <Spinner />
        </div>
      )}
    </div>
  );
}

/** The open session's settings as chips: model, effort, permissions and
 * account. A change applies to the next turn, as on the desktop. */
function SessionChips({ machineId, value, catalog, onChange }: { machineId: string; value: HostSession; catalog?: HostModelCatalog; onChange: (change: Change) => void }) {
  const app = useModel();
  const meta = value.session;
  const models = catalog?.models[meta.harness] ?? [];
  const current = models.find((item) => modelMatches(item, meta.model));
  const effort = effortSetting(current);
  const effortValue = effort ? (meta.modelSettings?.[effort.id] ?? effort.value) : undefined;
  return (
    <>
      <Chip
        icon={<HarnessIcon harness={meta.harness} size={13} />}
        label={app.modelName(machineId, meta.harness, meta.model)}
        disabled={!models.length}
        items={models.map((item) => ({ label: item.name, checked: modelMatches(item, meta.model), run: () => onChange({ model: item.id }) }))}
      />
      {effort ? (
        <Chip
          label={effort.options.find((option) => option.value === effortValue)?.label ?? effortValue ?? ""}
          items={effort.options.map((option) => ({
            label: option.label,
            checked: option.value === effortValue,
            run: () => onChange({ modelSettings: { ...(meta.modelSettings ?? {}), [effort.id]: option.value } }),
          }))}
        />
      ) : null}
      <Chip
        label={RUNTIME_MODES.find((mode) => mode.id === meta.runtimeMode)?.label ?? meta.runtimeMode}
        items={RUNTIME_MODES.map((mode) => ({ label: mode.label, checked: mode.id === meta.runtimeMode, run: () => onChange({ runtimeMode: mode.id }) }))}
      />
      <AccountChip machineId={machineId} harness={meta.harness} current={meta.providerAccountId} onChange={(providerAccountId) => onChange({ providerAccountId })} />
    </>
  );
}

function Queue({ value, run }: { value: HostSession; run: (input: Record<string, unknown>) => void }) {
  const queued = value.session.queuedMessages ?? [];
  if (!queued.length) return null;
  return (
    <div className="queue">
      {queued.map((message) => (
        <div key={message.id} className="queued">
          <span className="ellipsis grow">{message.text}</span>
          {value.status === "running" ? (
            <button className="link-button" onClick={() => run({ type: "queueSteer", messageId: message.id })}>
              Send now
            </button>
          ) : null}
          <button className="queued-remove" aria-label="Remove from queue" onClick={() => run({ type: "queueRemove", messageId: message.id })}>
            <Icon name="xmark" size={11} />
          </button>
        </div>
      ))}
      {value.session.queueStatus === "paused" ? (
        <button className="link-button meta" onClick={() => run({ type: "queueResume" })}>
          Resume queue
        </button>
      ) : null}
    </div>
  );
}

/** As the desktop's `UsageLimitNotice`: Resume once the limit has reset, or
 * resume at reset (cancellable) before; an account switch; Dismiss. */
function UsageLimit({
  machineId,
  limit,
  harness,
  account,
  onResume,
  onSet,
  onAccount,
}: {
  machineId: string;
  limit: NonNullable<HostSession["session"]["usageLimit"]>;
  harness: string;
  account?: string;
  onResume: () => void;
  onSet: (limit: unknown) => void;
  onAccount: (id: string) => void;
}) {
  useTicker(30_000);
  const waiting = limit.resetsAt ? limit.resetsAt > Date.now() : false;
  return (
    <div className="usage-limit">
      <div className="row-line top">
        <Icon name="gauge" size={16} className="amber" />
        <div className="grow">
          <div>Usage limit reached</div>
          {limit.resetsAt ? <div className="muted">{waiting ? `Resets ${resetTime(limit.resetsAt)}` : "Limit has reset"}</div> : null}
        </div>
        <button className="row-button" aria-label="Dismiss usage limit notice" onClick={() => onSet(null)}>
          <Icon name="xmark" size={12} />
        </button>
      </div>
      <div className="chips wrap">
        {!waiting ? (
          <Button icon="play" onClick={onResume}>
            Resume
          </Button>
        ) : limit.resumeAtReset ? (
          <Button icon="clock" onClick={() => onSet({ resumeAtReset: false })}>
            Resuming at reset
          </Button>
        ) : (
          <Button icon="clock" onClick={() => onSet({ resumeAtReset: true })}>
            Resume at reset
          </Button>
        )}
        <AccountChip machineId={machineId} harness={harness} current={account} onChange={onAccount} />
      </div>
    </div>
  );
}

function QuestionCard({
  prompt,
  onReply,
  onInteract,
}: {
  prompt: UserQuestionPrompt;
  onReply: (reply: Record<string, unknown>) => void;
  onInteract: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const toggle = (questionId: string, multiSelect: boolean, id: string) => {
    onInteract();
    const selected = answers[questionId] ?? [];
    setAnswers({
      ...answers,
      [questionId]: multiSelect
        ? selected.includes(id)
          ? selected.filter((item) => item !== id)
          : [...selected, id]
        : selected.length === 1 && selected[0] === id
          ? []
          : [id],
    });
  };
  /** As `buildQuestionReply`: only answered questions, skipped when none. */
  const reply = () => {
    const nextAnswers: Record<string, string[]> = {};
    const nextCustom: Record<string, string> = {};
    for (const question of prompt.questions) {
      const selected = answers[question.id] ?? [];
      const text = custom[question.id]?.trim() ?? "";
      if (selected.length) nextAnswers[question.id] = selected;
      if (question.allowCustom && text) nextCustom[question.id] = text;
    }
    if (!Object.keys(nextAnswers).length && !Object.keys(nextCustom).length) return { kind: "skipped" };
    return { kind: "answered", answers: nextAnswers, ...(Object.keys(nextCustom).length ? { custom: nextCustom } : {}) };
  };
  return (
    <div className="question">
      {prompt.title ? <div className="strong">{prompt.title}</div> : null}
      {prompt.questions.map((question) => (
        <div key={question.id} className="question-item">
          {question.header ? <CardLabel text={question.header} /> : null}
          <div className="strong">{question.prompt}</div>
          {question.options.map((option) => {
            const selected = answers[question.id]?.includes(option.id) ?? false;
            return (
              <button key={option.id} className={`option${selected ? " on" : ""}`} onClick={() => toggle(question.id, question.multiSelect, option.id)}>
                <span>{option.label}</span>
                {option.description ? <span className="meta muted">{option.description}</span> : null}
              </button>
            );
          })}
          {question.allowCustom ? (
            <input className="field" placeholder="Other…" value={custom[question.id] ?? ""} onChange={(event) => {
                onInteract();
                setCustom({ ...custom, [question.id]: event.target.value });
              }} />
          ) : null}
        </div>
      ))}
      <div className="button-row end">
        <Button onClick={() => onReply({ kind: "skipped" })}>Skip</Button>
        <Button primary onClick={() => onReply(reply())}>
          Answer
        </Button>
      </div>
    </div>
  );
}
