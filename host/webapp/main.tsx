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
import type { RuntimeMode } from "../../src/features/sessions/model/session";
import { buildQuestionReply, type UserQuestionPrompt } from "../../src/features/sessions/model/userQuestion";
import { command, describe, login, logout, rpc, syncSession, Unauthorized } from "./api";
import { Transcript } from "./Transcript";
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
        <button className="primary" disabled={busy || !token.trim()}>
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
        <img src="side.png" alt="" width={22} height={22} />
        <span className="host-name">{host.name}</span>
        <span className="version">{host.version}</span>
        <button className="icon close" onClick={onClose} aria-label="Close menu">✕</button>
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
                  +
                </button>
              </div>
              {list.map((session) => {
                const active = route.kind === "session" && route.sessionId === session.id;
                return (
                  <a
                    key={session.id}
                    className={`session${active ? " active" : ""}${session.archived ? " archived" : ""}`}
                    href={`#/s/${encodeURIComponent(project.id)}/${encodeURIComponent(session.id)}`}
                    onClick={onClose}
                  >
                    <span className={`dot ${session.needsInput ? "input" : session.status}`} />
                    <span className="title">{session.title || "New session"}</span>
                    <span className="meta">{ago(session.updatedAt)}</span>
                  </a>
                );
              })}
            </section>
          );
        })}
      </div>
      <Usage accounts={accounts} />
      <footer>
        <label>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Archived
        </label>
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
  children,
}: {
  placeholder: string;
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
        {running && onStop ? (
          <button className="stop" onClick={onStop} aria-label="Stop">■</button>
        ) : null}
        <button className="send primary" disabled={!text.trim() || sending || disabled} onClick={() => void submit()} aria-label="Send">
          ↑
        </button>
      </div>
    </div>
  );
}

function SessionView({ sessionId, onError }: { sessionId: string; onError: (error: unknown) => void }) {
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
            canDecide={running && !!value.runId}
            onDecide={(requestId, decision) =>
              void run({ type: "approve", sessionId, runId: value.runId!, requestId, decision })
            }
          />
          {running ? <div className="working"><span className="dot running" /> Working…</div> : null}
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
        placeholder={running ? "Queue a follow-up…" : "Message…"}
        running={running}
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

function NewSession({
  host,
  project,
  accounts,
  onError,
}: {
  host: HostDescriptor;
  project: HostProject;
  accounts: HostAccountSummary[];
  onError: (error: unknown) => void;
}) {
  const [catalog, setCatalog] = useState<HostModelCatalog>();
  const [harness, setHarness] = useState<RemoteProvider>(host.providers.includes("claude") ? "claude" : host.providers[0]);
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<RuntimeMode>("supervised");
  const providerAccounts = accounts.filter((account) => account.provider === harness);
  const [account, setAccount] = useState("");
  useEffect(() => {
    rpc<HostModelCatalog>("models.list", { projectId: project.id }).then(setCatalog, onError);
  }, [project.id, onError]);
  const models = catalog?.models[harness] ?? [];
  useEffect(() => {
    if (!models.some((item) => item.id === model)) setModel(models[0]?.id ?? "");
  }, [models, model]);
  useEffect(() => {
    setAccount(providerAccounts.find((item) => item.pool)?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harness, accounts.length]);
  return (
    <div className="session-view">
      <div className="transcript">
        <div className="transcript-inner new-session">
          <p className="muted">{project.cwd}</p>
          <label>
            Agent
            <select value={harness} onChange={(event) => setHarness(event.target.value as RemoteProvider)}>
              {host.providers.map((provider) => (
                <option key={provider} value={provider}>{provider}</option>
              ))}
            </select>
          </label>
          <label>
            Model
            <select value={model} onChange={(event) => setModel(event.target.value)} disabled={!models.length}>
              {!catalog ? <option>Loading…</option> : null}
              {models.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
            {catalog?.errors[harness] ? <span className="error">{catalog.errors[harness]}</span> : null}
          </label>
          <label>
            Permissions
            <select value={mode} onChange={(event) => setMode(event.target.value as RuntimeMode)}>
              {MODES.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          </label>
          {providerAccounts.length ? (
            <label>
              Account
              <select value={account} onChange={(event) => setAccount(event.target.value)}>
                <option value="">Default</option>
                {providerAccounts.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </div>
      <Composer
        placeholder="What should the agent do?"
        disabled={!model}
        onSend={async (text) => {
          try {
            const receipt = await command({
              type: "create",
              projectId: project.id,
              harness,
              model,
              runtimeMode: mode,
              ...(account ? { providerAccountId: account } : {}),
            });
            await command({ type: "send", sessionId: receipt.sessionId, text });
            go({ kind: "session", projectId: project.id, sessionId: receipt.sessionId });
          } catch (error) {
            onError(error);
            throw error;
          }
        }}
      />
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
            ☰{attention ? <span className="badge">{attention}</span> : null}
          </button>
          <div className="topbar-title">
            <span>{route.kind === "new" ? `New session · ${project?.name ?? ""}` : summary?.title || (route.kind === "home" ? host.name : "")}</span>
            {summary ? (
              <span className="muted">
                {project?.name} · {summary.harness}
                {summary.model ? ` · ${summary.model.split(":").pop()}` : ""}
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
          <SessionView key={route.sessionId} sessionId={route.sessionId} onError={onError} />
        ) : route.kind === "new" && project ? (
          <NewSession key={project.id} host={host} project={project} accounts={accounts} onError={onError} />
        ) : (
          <Home sessions={sessions} projects={projects} />
        )}
      </main>
    </div>
  );
}

/** What runs or waits right now, across every project. */
function Home({ sessions, projects }: { sessions: Record<string, HostSessionSummary[]>; projects: HostProject[] }) {
  const all = Object.values(sessions).flat().filter((session) => !session.archived);
  const live = all
    .filter((session) => session.needsInput || session.status === "running")
    .sort((a, b) => Number(!!b.needsInput) - Number(!!a.needsInput) || b.updatedAt - a.updatedAt);
  const recent = all.filter((session) => !live.includes(session)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12);
  const name = (id: string) => projects.find((project) => project.id === id)?.name ?? "";
  const card = (session: HostSessionSummary) => (
    <a key={session.id} className="card" href={`#/s/${encodeURIComponent(session.projectId)}/${encodeURIComponent(session.id)}`}>
      <span className={`dot ${session.needsInput ? "input" : session.status}`} />
      <span className="card-body">
        <span className="title">{session.title || "New session"}</span>
        <span className="muted">
          {name(session.projectId)} · {session.harness} · {ago(session.updatedAt)}
          {session.needsInput ? " · needs you" : ""}
        </span>
      </span>
    </a>
  );
  return (
    <div className="home">
      <h2>Now</h2>
      {live.length ? live.map(card) : <p className="muted">Nothing is running.</p>}
      <h2>Recent</h2>
      {recent.map(card)}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
