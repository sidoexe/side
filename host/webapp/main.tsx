import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  HostAccountSummary,
  HostDescriptor,
  HostModelCatalog,
  HostProject,
  HostSessionSummary,
  RemoteProvider,
} from "../../src/features/connections/model/protocol";
import { sessionDisplayTitle, type RuntimeMode } from "../../src/features/sessions/model/session";
import { command, describe, login, logout, rpc, Unauthorized } from "./api";
import { SessionView } from "./SessionView";
import { ago, BranchIcon, Chip, Composer, go, MODES, tilde, usePoll, useRoute, type Route } from "./ui";
import { HarnessIcon } from "../../src/features/sessions/ui/HarnessIcon";
import { findModel, setHarnessModels } from "../../src/features/sessions/model/models";
import "./styles.css";

const modelName = (session: HostSessionSummary) =>
  (session.model && findModel(session.model)?.name) || session.model?.split(":").pop() || session.harness;

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
          onSend={async ({ text, attachments, plan }) => {
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
              await command({
                type: "send",
                sessionId: receipt.sessionId,
                text,
                ...(attachments.length ? { attachments } : {}),
                ...(plan ? { intent: "plan" as const } : {}),
              });
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
          {summary ? <SessionMenu summary={summary} onError={onError} /> : null}
        </div>
        {error ? (
          <div className="toast" onClick={() => setError("")}>{error}</div>
        ) : null}
        {route.kind === "session" ? (
          <SessionView
            key={route.sessionId}
            sessionId={route.sessionId}
            projectId={route.projectId}
            branch={summary?.branch}
            accounts={accounts}
            onError={onError}
          />
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

/** Rename, pin, archive or delete the open session. */
function SessionMenu({ summary, onError }: { summary: HostSessionSummary; onError: (error: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const update = (patch: Record<string, unknown>) =>
    rpc("sessions.update", { projectId: summary.projectId, sessionId: summary.id, ...patch }).catch(onError);
  const actions: [string, () => unknown][] = [
    [
      "Rename",
      () => {
        const title = prompt("Session name", sessionDisplayTitle(summary.title, summary.harness));
        if (title?.trim()) void update({ title: title.trim() });
      },
    ],
    [summary.pinned ? "Unpin" : "Pin", () => void update({ pinned: !summary.pinned })],
    [
      summary.archived ? "Unarchive" : "Archive",
      () => void update({ archived: !summary.archived }).then(() => !summary.archived && go({ kind: "home" })),
    ],
    [
      "Delete",
      () => {
        if (!confirm(`Delete "${sessionDisplayTitle(summary.title, summary.harness)}"? Its transcript is removed from the host.`)) return;
        void rpc("sessions.delete", { projectId: summary.projectId, sessionId: summary.id }).then(() => go({ kind: "home" }), onError);
      },
    ],
  ];
  return (
    <div className="menu-anchor">
      <button className="icon" aria-label="Session actions" onClick={() => setOpen(!open)}>
        <svg className="glyph" viewBox="0 0 16 16" aria-hidden>
          <circle cx="3.5" cy="8" r="1.2" fill="currentColor" /><circle cx="8" cy="8" r="1.2" fill="currentColor" /><circle cx="12.5" cy="8" r="1.2" fill="currentColor" />
        </svg>
      </button>
      {open ? (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="popover">
            {actions.map(([label, action]) => (
              <button
                key={label}
                className={label === "Delete" ? "danger" : ""}
                onClick={() => {
                  setOpen(false);
                  action();
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      ) : null}
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
