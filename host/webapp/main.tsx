import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  HostAccountSummary,
  HostDescriptor,
  HostModelCatalog,
  HostProject,
  HostSession,
  HostSessionSummary,
  RemoteProvider,
} from "../../src/features/connections/model/protocol";
import { sessionDisplayTitle, type RuntimeMode } from "../../src/features/sessions/model/session";
import { buildQuestionReply, type UserQuestionPrompt } from "../../src/features/sessions/model/userQuestion";
import { command, describe, login, logout, rpc, syncSession, Unauthorized } from "./api";
import { Transcript } from "./Transcript";
import { HarnessIcon } from "../../src/features/sessions/ui/HarnessIcon";
import { findModel, setHarnessModels } from "../../src/features/sessions/model/models";
import "./styles.css";

type Route = { kind: "home" } | { kind: "session"; projectId: string; sessionId: string } | { kind: "new"; projectId: string };

function parseRoute(): Route {
  const [kind, projectId, sessionId] = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (kind === "s" && projectId && sessionId) return { kind: "session", projectId, sessionId };
  if (kind === "new" && projectId) return { kind: "new", projectId };
  return { kind: "home" };
}

function go(route: Route) {
  location.hash =
    route.kind === "session"
      ? `#/s/${encodeURIComponent(route.projectId)}/${encodeURIComponent(route.sessionId)}`
      : route.kind === "new"
        ? `#/new/${encodeURIComponent(route.projectId)}`
        : "#/";
}

function useRoute(): Route {
  const [route, setRoute] = useState(parseRoute);
  useEffect(() => {
    const update = () => setRoute(parseRoute());
    addEventListener("hashchange", update);
    return () => removeEventListener("hashchange", update);
  }, []);
  return route;
}

/** Runs `tick` now and every `ms` while the page is visible. */
function usePoll(tick: () => Promise<void> | void, ms: number, deps: unknown[]) {
  const latest = useRef(tick);
  latest.current = tick;
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      if (!document.hidden) await Promise.resolve(latest.current()).catch(() => undefined);
      if (!stopped) timer = setTimeout(loop, ms);
    };
    const wake = () => {
      if (document.hidden) return;
      clearTimeout(timer);
      void loop();
    };
    void loop();
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps]);
}

const ago = (time?: number) => {
  if (!time) return "";
  const s = Math.max(0, (Date.now() - time) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

const tilde = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+/, "~");

const modelName = (session: HostSessionSummary) =>
  (session.model && findModel(session.model)?.name) || session.model?.split(":").pop() || session.harness;

const BranchIcon = () => (
  <svg className="glyph" viewBox="0 0 16 16" aria-hidden>
    <circle cx="5" cy="4" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="5" cy="12" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="11" cy="6" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <path d="M5 5.6v4.8M11 7.6c0 2-2 2.4-4.6 3.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);

/** One session as the IDE's sidebar shows it: agent and model, title, branch. */
function SessionRow({ session, active, onClick }: { session: HostSessionSummary; active?: boolean; onClick?: () => void }) {
  const state = session.needsInput ? "input" : session.status;
  return (
    <a
      className={`session${active ? " active" : ""}${session.archived ? " archived" : ""}`}
      href={`#/s/${encodeURIComponent(session.projectId)}/${encodeURIComponent(session.id)}`}
      onClick={onClick}
    >
      <span className="session-line meta">
        <HarnessIcon harness={session.harness} className="harness" />
        <span className="ellipsis">{modelName(session)}</span>
        <span className="time">{ago(session.updatedAt)}</span>
      </span>
      <span className="session-line">
        <span className={`session-title ellipsis${state === "running" ? " shimmer" : ""}`}>{sessionDisplayTitle(session.title, session.harness) || "New session"}</span>
        {state === "input" ? <span className="pill">Needs you</span> : state === "interrupted" ? <span className="pill red">Interrupted</span> : null}
      </span>
      {session.repo || session.branch ? (
        <span className="session-line meta">
          <BranchIcon />
          <span className="ellipsis">{[session.repo, session.branch].filter(Boolean).join("/")}</span>
        </span>
      ) : null}
    </a>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="login">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            await login(token.trim());
            onDone();
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
          } finally {
            setBusy(false);
          }
        }}
      >
        <img src="side.png" alt="" width={56} height={56} />
        <h1>sIDE Host</h1>
        <p>
          Paste a device token. Create one on the host with
          <code>~/.side-host/bin/side-host pair --name "Web"</code>
        </p>
        <input
          type="password"
          autoComplete="off"
          placeholder="Device token"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          autoFocus
        />
        {error ? <div className="error">{error}</div> : null}
        <button className="btn primary" disabled={busy || !token.trim()}>
          Sign in
        </button>
      </form>
    </div>
  );
}

function Usage({ accounts }: { accounts: HostAccountSummary[] }) {
  const named = accounts.filter((account) => !account.pool);
  if (!named.length) return null;
  return (
    <div className="usage">
      {named.map((account) => (
        <div key={account.id} className="usage-row" title={account.usage?.error}>
          <span className="usage-label">{account.label}</span>
          {(["fiveHour", "sevenDay"] as const).map((window) => {
            const used = account.usage?.[window]?.used;
            return (
              <span key={window} className="bar" title={`${window === "fiveHour" ? "5h" : "7d"}: ${used ?? "?"}%`}>
                <span style={{ width: `${Math.min(100, used ?? 0)}%` }} className={used != null && used >= 90 ? "full" : ""} />
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Sidebar({
  host,
  projects,
  sessions,
  accounts,
  route,
  onClose,
  onLogout,
}: {
  host: HostDescriptor;
  projects: HostProject[];
  sessions: Record<string, HostSessionSummary[]>;
  accounts: HostAccountSummary[];
  route: Route;
  onClose: () => void;
  onLogout: () => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();
  return (
    <nav className="sidebar">
      <header>
        <img src="side.png" alt="" width={18} height={18} />
        <span className="host-name">{host.name}</span>
        <span className="version">{host.version}</span>
        <button className="icon close" onClick={onClose} aria-label="Close menu">
          <svg className="glyph" viewBox="0 0 16 16" aria-hidden><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </header>
      <input className="search" placeholder="Filter sessions" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="projects">
        {projects.map((project) => {
          const list = (sessions[project.id] ?? [])
            .filter((session) => showArchived || !session.archived)
            .filter((session) => !query || session.title.toLowerCase().includes(query) || project.name.toLowerCase().includes(query))
            .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt);
          if (query && !list.length) return null;
          return (
            <section key={project.id}>
              <div className="project">
                <span title={project.cwd}>{project.name}</span>
                <button
                  className="icon"
                  aria-label={`New session in ${project.name}`}
                  onClick={() => {
                    go({ kind: "new", projectId: project.id });
                    onClose();
                  }}
                >
                  <svg className="glyph" viewBox="0 0 16 16" aria-hidden><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                </button>
              </div>
              {list.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  active={route.kind === "session" && route.sessionId === session.id}
                  onClick={onClose}
                />
              ))}
            </section>
          );
        })}
      </div>
      <Usage accounts={accounts} />
      <footer>
        <label>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Archived
        </label>
        <button
          className="theme-toggle"
          onClick={() => {
            const light = document.documentElement.classList.toggle("theme-light");
            localStorage.setItem("side-web-theme", light ? "light" : "dark");
          }}
        >
          Theme
        </button>
        <button className="link" onClick={onLogout}>Sign out</button>
      </footer>
    </nav>
  );
}

function Question({ prompt, onReply }: { prompt: UserQuestionPrompt; onReply: (reply: ReturnType<typeof buildQuestionReply>) => void }) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  return (
    <div className="question">
      {prompt.questions.map((question) => (
        <fieldset key={question.id}>
          <legend>{question.prompt}</legend>
          {question.options.map((option) => {
            const selected = answers[question.id]?.includes(option.id) ?? false;
            return (
              <button
                key={option.id}
                className={`option${selected ? " selected" : ""}`}
                onClick={() =>
                  setAnswers({
                    ...answers,
                    [question.id]: question.multiSelect
                      ? selected
                        ? answers[question.id].filter((id) => id !== option.id)
                        : [...(answers[question.id] ?? []), option.id]
                      : [option.id],
                  })
                }
              >
                <strong>{option.label}</strong>
                {option.description ? <span>{option.description}</span> : null}
              </button>
            );
          })}
          {question.allowCustom ? (
            <input
              placeholder="Other answer"
              value={custom[question.id] ?? ""}
              onChange={(event) => setCustom({ ...custom, [question.id]: event.target.value })}
            />
          ) : null}
        </fieldset>
      ))}
      <div className="row">
        <button className="primary" onClick={() => onReply(buildQuestionReply(prompt.questions, answers, custom))}>
          Answer
        </button>
        <button onClick={() => onReply({ kind: "skipped" })}>Skip</button>
      </div>
    </div>
  );
}

function Composer({
  placeholder,
  running,
  disabled,
  onSend,
  onStop,
  context,
  tools,
  children,
}: {
  placeholder: string;
  context?: React.ReactNode;
  tools?: React.ReactNode;
  running?: boolean;
  disabled?: boolean;
  onSend: (text: string) => Promise<void>;
  onStop?: () => void;
  children?: React.ReactNode;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);
  const submit = async () => {
    const value = text.trim();
    if (!value || sending || disabled) return;
    setSending(true);
    try {
      await onSend(value);
      setText("");
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="composer">
      {children}
      <div className="composer-box">
        {context ? <div className="composer-context">{context}</div> : null}
        <textarea
          ref={area}
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends on a keyboard; on touch screens the button does.
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && matchMedia("(pointer: fine)").matches) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-bar">
          <span className="composer-tools">{tools ?? (running ? <span className="composer-hint">Queues until the turn ends</span> : null)}</span>
          {running && onStop ? (
            <button className="square stop" onClick={onStop} aria-label="Stop">
              <svg className="glyph" viewBox="0 0 16 16" aria-hidden><rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="currentColor" /></svg>
            </button>
          ) : null}
          <button className="square send" disabled={!text.trim() || sending || disabled} onClick={() => void submit()} aria-label="Send">
            <svg className="glyph" viewBox="0 0 16 16" aria-hidden><path d="M8 12.5v-9M4 7.5l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
      </div>
    </div>
  );
}

function SessionView({ sessionId, branch, onError }: { sessionId: string; branch?: string; onError: (error: unknown) => void }) {
  const [value, setValue] = useState<HostSession>();
  const known = useRef<HostSession | undefined>(undefined);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    known.current = undefined;
    pinned.current = true;
    setValue(undefined);
  }, [sessionId]);
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
    }
  };
  if (!value) return <div className="empty">Loading…</div>;
  const session = value.session;
  const running = value.status === "running";
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
              void run({ type: "approve", sessionId, runId: value.runId!, requestId, decision })
            }
          />
          {value.status === "interrupted" ? <div className="system interrupt">Interrupted</div> : null}
          {session.usageLimit ? (
            <div className="system error">
              Usage limit reached{session.usageLimit.resetsAt ? `, resets at ${new Date(session.usageLimit.resetsAt).toLocaleString()}` : ""}.
              <div className="row">
                <button onClick={() => void run({ type: "send", sessionId, text: "Continue." })}>Resume</button>
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
        context={
          <>
            <span className="mono ellipsis">{tilde(session.worktreeCwd ?? session.cwd)}</span>
            {branch ? <span className="mono"><BranchIcon /> {branch}</span> : null}
          </>
        }
        onStop={value.runId ? () => void run({ type: "cancel", sessionId, runId: value.runId! }) : undefined}
        onSend={(text) => run(running ? { type: "queue", sessionId, text } : { type: "send", sessionId, text })}
      >
        {session.pendingQuestion && value.runId ? (
          <Question
            prompt={session.pendingQuestion}
            onReply={(reply) =>
              void run({ type: "answer", sessionId, runId: value.runId!, requestId: session.pendingQuestion!.requestId, reply })
            }
          />
        ) : null}
        {session.queuedMessages?.length ? (
          <div className="queue">
            {session.queuedMessages.map((message) => (
              <div key={message.id} className="queued">
                <span>{message.text}</span>
                <button className="icon" aria-label="Remove" onClick={() => void run({ type: "queueRemove", sessionId, messageId: message.id })}>✕</button>
              </div>
            ))}
            {session.queueStatus === "paused" ? (
              <button className="link" onClick={() => void run({ type: "queueResume", sessionId })}>Resume queue</button>
            ) : null}
          </div>
        ) : null}
      </Composer>
    </div>
  );
}

const MODES: { id: RuntimeMode; label: string }[] = [
  { id: "supervised", label: "Ask" },
  { id: "auto-accept-edits", label: "Accept edits" },
  { id: "auto", label: "Auto" },
  { id: "full-access", label: "Full access" },
];

/** A native select dressed as one of the composer's chips. */
function Chip<T extends string>({
  value,
  onChange,
  children,
  icon,
  label,
  disabled,
}: {
  value: T;
  onChange: (value: T) => void;
  children: React.ReactNode;
  icon?: React.ReactNode;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className={`chip${disabled ? " disabled" : ""}`}>
      {icon}
      <span className="ellipsis">{label}</span>
      <svg className="chip-caret" viewBox="0 0 16 16" aria-hidden><path d="M4.5 6.5L8 10l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as T)}>{children}</select>
    </label>
  );
}

/** The IDE's empty session: the project's name over a composer whose chips
 * pick the project, agent and model, permissions and account. */
function NewSession({
  host,
  project,
  projects,
  accounts,
  onError,
}: {
  host: HostDescriptor;
  project: HostProject;
  projects?: HostProject[];
  accounts: HostAccountSummary[];
  onError: (error: unknown) => void;
}) {
  const [projectId, setProjectId] = useState(project.id);
  const current = projects?.find((item) => item.id === projectId) ?? project;
  const [catalog, setCatalog] = useState<HostModelCatalog>();
  const [choice, setChoice] = useState("");
  const [mode, setMode] = useState<RuntimeMode>("supervised");
  const [account, setAccount] = useState("");
  useEffect(() => setProjectId(project.id), [project.id]);
  useEffect(() => {
    rpc<HostModelCatalog>("models.list", { projectId: current.id }).then(setCatalog, onError);
  }, [current.id, onError]);
  const options = host.providers.flatMap((harness) =>
    (catalog?.models[harness] ?? []).map((model) => ({ harness, model, key: `${harness}|${model.id}` })),
  );
  useEffect(() => {
    if (options.some((option) => option.key === choice)) return;
    const preferred = options.find((option) => option.harness === "claude") ?? options[0];
    setChoice(preferred?.key ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog]);
  const selected = options.find((option) => option.key === choice);
  const harness = selected?.harness;
  const providerAccounts = accounts.filter((item) => item.provider === harness);
  useEffect(() => {
    setAccount(providerAccounts.find((item) => item.pool)?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harness, accounts.length]);
  return (
    <div className="session-view">
      <div className="empty-session">
        <div className="empty-title ellipsis">{current.name}</div>
        <Composer
          placeholder="Ask, build…"
          disabled={!selected}
          context={<span className="mono ellipsis">{tilde(current.cwd)}</span>}
          tools={
            <>
              {projects && projects.length > 1 ? (
                <Chip value={current.id} onChange={setProjectId} label={current.name}>
                  {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </Chip>
              ) : null}
              <Chip
                value={choice}
                onChange={setChoice}
                disabled={!options.length}
                icon={harness ? <HarnessIcon harness={harness} className="harness" /> : undefined}
                label={selected?.model.name ?? (catalog ? "No models" : "Loading…")}
              >
                {host.providers.map((provider) =>
                  catalog?.models[provider]?.length ? (
                    <optgroup key={provider} label={provider}>
                      {catalog.models[provider]!.map((model) => (
                        <option key={model.id} value={`${provider}|${model.id}`}>{model.name}</option>
                      ))}
                    </optgroup>
                  ) : null,
                )}
              </Chip>
              <Chip value={mode} onChange={setMode} label={MODES.find((item) => item.id === mode)!.label}>
                {MODES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </Chip>
              {providerAccounts.length ? (
                <Chip value={account} onChange={setAccount} label={providerAccounts.find((item) => item.id === account)?.label ?? "Default"}>
                  <option value="">Default</option>
                  {providerAccounts.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </Chip>
              ) : null}
            </>
          }
          onSend={async (text) => {
            if (!selected) return;
            try {
              const receipt = await command({
                type: "create",
                projectId: current.id,
                harness: selected.harness,
                model: selected.model.id,
                runtimeMode: mode,
                ...(account ? { providerAccountId: account } : {}),
              });
              await command({ type: "send", sessionId: receipt.sessionId, text });
              go({ kind: "session", projectId: current.id, sessionId: receipt.sessionId });
            } catch (error) {
              onError(error);
              throw error;
            }
          }}
        />
        {catalog?.errors[harness ?? "claude"] ? <div className="error">{catalog.errors[harness ?? "claude"]}</div> : null}
      </div>
    </div>
  );
}

function App() {
  const route = useRoute();
  const [host, setHost] = useState<HostDescriptor | null>();
  const [projects, setProjects] = useState<HostProject[]>([]);
  const [sessions, setSessions] = useState<Record<string, HostSessionSummary[]>>({});
  const [accounts, setAccounts] = useState<HostAccountSummary[]>([]);
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState("");
  const onError = useCallback((reason: unknown) => {
    if (reason instanceof Unauthorized) setHost(null);
    else setError(reason instanceof Error ? reason.message : String(reason));
  }, []);
  const connect = useCallback(() => {
    describe<HostDescriptor>().then(setHost, (reason) => {
      if (reason instanceof Unauthorized) setHost(null);
      else onError(reason);
    });
  }, [onError]);
  useEffect(connect, [connect]);
  const [, setModelsLoaded] = useState(0);
  useEffect(() => {
    if (!host) return;
    // Model names, as the IDE shows them ("Claude Opus 5" rather than "opus").
    rpc<HostModelCatalog>("models.list").then((catalog) => {
      for (const [harness, models] of Object.entries(catalog.models))
        if (models?.length) setHarnessModels(harness as RemoteProvider, models);
      setModelsLoaded((n) => n + 1);
    }, () => undefined);
  }, [host?.environmentId]);
  usePoll(
    async () => {
      if (!host) return;
      try {
        const list = await rpc<HostProject[]>("projects.list");
        setProjects(list);
        const entries = await Promise.all(
          list.map(async (project) => [project.id, await rpc<HostSessionSummary[]>("sessions.list", { projectId: project.id })] as const),
        );
        setSessions(Object.fromEntries(entries));
        setAccounts(await rpc<HostAccountSummary[]>("accounts.list"));
      } catch (reason) {
        onError(reason);
      }
    },
    5000,
    [host?.environmentId],
  );
  const summary = useMemo(() => {
    if (route.kind !== "session") return undefined;
    return sessions[route.projectId]?.find((session) => session.id === route.sessionId);
  }, [route, sessions]);
  const project = route.kind !== "home" ? projects.find((item) => item.id === route.projectId) : undefined;
  const attention = Object.values(sessions).flat().filter((session) => session.needsInput && !session.archived).length;
  useEffect(() => {
    document.title = attention ? `(${attention}) sIDE Host` : "sIDE Host";
  }, [attention]);

  if (host === undefined) return <div className="empty">Connecting…</div>;
  if (host === null) return <Login onDone={connect} />;
  return (
    <div className={`app${menu ? " menu-open" : ""}`}>
      <Sidebar
        host={host}
        projects={projects}
        sessions={sessions}
        accounts={accounts}
        route={route}
        onClose={() => setMenu(false)}
        onLogout={() => void logout().then(() => setHost(null))}
      />
      <div className="scrim" onClick={() => setMenu(false)} />
      <main>
        <div className="topbar">
          <button className="icon menu" onClick={() => setMenu(true)} aria-label="Open menu">
            <svg className="glyph" viewBox="0 0 16 16" aria-hidden><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
            {attention ? <span className="badge">{attention}</span> : null}
          </button>
          <div className="topbar-title">
            <span>{route.kind === "new" ? `New session · ${project?.name ?? ""}` : (summary && sessionDisplayTitle(summary.title, summary.harness)) || (route.kind === "home" ? host.name : "")}</span>
            {summary ? (
              <span className="muted">
                {project?.name} · {modelName(summary)}
                {summary.branch ? ` · ${summary.branch}` : ""}
                {summary.accountInUse ? ` · ${summary.accountInUse}` : ""}
              </span>
            ) : null}
          </div>
          {summary ? (
            <button
              className="link"
              title={summary.archived ? "Unarchive" : "Archive"}
              onClick={() =>
                void rpc("sessions.update", { projectId: summary.projectId, sessionId: summary.id, archived: !summary.archived }).then(
                  () => !summary.archived && go({ kind: "home" }),
                  onError,
                )
              }
            >
              {summary.archived ? "Unarchive" : "Archive"}
            </button>
          ) : null}
        </div>
        {error ? (
          <div className="toast" onClick={() => setError("")}>{error}</div>
        ) : null}
        {route.kind === "session" ? (
          <SessionView key={route.sessionId} sessionId={route.sessionId} branch={summary?.branch} onError={onError} />
        ) : route.kind === "new" && project ? (
          <NewSession key={project.id} host={host} project={project} accounts={accounts} onError={onError} />
        ) : (
          <>
            <Home sessions={sessions} />
            {projects.length ? (
              <div className="wide-only">
                <NewSession host={host} project={recentProject(projects, sessions)} projects={projects} accounts={accounts} onError={onError} />
              </div>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}

/** The project worked in last, which a new session starts in by default. */
function recentProject(projects: HostProject[], sessions: Record<string, HostSessionSummary[]>): HostProject {
  const latest = Object.values(sessions).flat().sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return projects.find((project) => project.id === latest?.projectId) ?? projects[0];
}

/** What runs or waits right now, across every project. */
function Home({ sessions }: { sessions: Record<string, HostSessionSummary[]> }) {
  const all = Object.values(sessions).flat().filter((session) => !session.archived);
  const live = all
    .filter((session) => session.needsInput || session.status === "running")
    .sort((a, b) => Number(!!b.needsInput) - Number(!!a.needsInput) || b.updatedAt - a.updatedAt);
  const recent = all.filter((session) => !live.includes(session)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12);
  return (
    <div className="home narrow-only">
      <div className="section-label">Now</div>
      {live.length ? <div className="list">{live.map((session) => <SessionRow key={session.id} session={session} />)}</div> : <p className="muted empty-line">Nothing is running.</p>}
      <div className="section-label">Recent</div>
      <div className="list">{recent.map((session) => <SessionRow key={session.id} session={session} />)}</div>
    </div>
  );
}

if (localStorage.getItem("side-web-theme") === "light") document.documentElement.classList.add("theme-light");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
