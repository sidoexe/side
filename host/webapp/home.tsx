import { useEffect, useState } from "react";
import { LOCAL } from "./api";
import {
  ago,
  displayTitle,
  folderName,
  isDone,
  isDraftOnly,
  isFailedTurn,
  isRunning,
  limitedUntil,
  resetTime,
  tilde,
  type HostAccountSummary,
} from "./model";
import { model as appModel, useModel, type MachineProject, type MachineSession, type MachineState, type Route } from "./store";
import { Button, HarnessIcon, Icon, Mascot, Menu, NavBar, Pill, SectionLabel, Spinner, useContextMenu, type MenuItem } from "./ui";
import { useNotifications } from "./push";
import { HostAccountsSheet } from "./accounts";

const sessionRoute = (s: MachineSession): Route => ({ kind: "session", machineId: s.machineId, projectId: s.projectId, sessionId: s.id });
const rowKey = (s: { machineId: string; id: string }) => `${s.machineId}:${s.id}`;

/** What needs you, across every machine and project: to review, working, checked. */
export function NowView() {
  const model = useModel();
  const [checkedOpen, setCheckedOpen] = useState(false);
  const toReview = model.toReview();
  const working = model.working();
  const checked = model.checked();
  return (
    <div className="screen sidebar">
      <NavBar
        sidebar
        leading={<HostHeader />}
        trailing={
          <>
            <NewSessionButton />
            <HomeMenu />
          </>
        }
      />
      <div className="scroll">
        <OfflineMachines />
        {toReview.length ? <SectionLabel text="To review" /> : null}
        {toReview.map((session) => (
          <div key={rowKey(session)} className="review-row">
            <SessionLink session={session} showProject />
            {isDone(session) ? (
              <button className="check-button" aria-label="Mark checked" onClick={() => void model.markChecked(session)}>
                <Icon name="checkCircle" size={20} />
              </button>
            ) : null}
          </div>
        ))}
        {working.length ? <SectionLabel text="Working" /> : null}
        {working.map((session) => (
          <SessionLink key={rowKey(session)} session={session} showProject />
        ))}
        {model.machine(LOCAL)?.host && !toReview.length && !working.length ? (
          <div className="empty">
            <Icon name="checkCircle" size={30} />
            <span>Nothing waits on you</span>
          </div>
        ) : null}
        {checked.length ? (
          <>
            <button className="section-label fold" aria-label={`Checked, ${checked.length}`} onClick={() => setCheckedOpen(!checkedOpen)}>
              <span>Checked</span>
              <span className="mono-small">{checked.length}</span>
              <span className="spacer" />
              <Icon name={checkedOpen ? "chevronUp" : "chevronDown"} size={11} />
            </button>
            {checkedOpen
              ? checked.map((session) => (
                  <div key={rowKey(session)} className="faded">
                    <SessionLink session={session} showProject />
                  </div>
                ))
              : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

/** Machines that could not be read: their sessions are the last ones known. */
function OfflineMachines() {
  const model = useModel();
  const offline = model.state.machines.filter((m) => m.id !== LOCAL && m.offline);
  if (!offline.length) return null;
  return (
    <div className="machine-warning">
      <Icon name="offline" size={14} className="amber" />
      <span className="small">
        {offline.map((m) => m.name).join(", ")} {offline.length === 1 ? "is" : "are"} unreachable; showing the last sessions known.
      </span>
    </div>
  );
}

/** Every machine's projects of the rail, folded to their counts until opened. */
export function ProjectsView() {
  const model = useModel();
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();
  const browsable = model.state.machines.filter((m) => model.can("projects.browse", m.id));
  const browse = browsable.length > 1
    ? (
        <Menu
          ariaLabel="Open folder"
          label={<Icon name="folderPlus" size={21} />}
          items={[{ kind: "section", label: "Open a folder of" }, ...browsable.map((m): MenuItem => ({ label: m.name, run: () => model.push({ kind: "browse", machineId: m.id }) }))]}
        />
      )
    : browsable.length === 1
      ? (
          <button className="bar-button" aria-label="Open folder" onClick={() => model.push({ kind: "browse", machineId: browsable[0].id })}>
            <Icon name="folderPlus" size={21} />
          </button>
        )
      : null;
  const local = model.machine(LOCAL);
  return (
    <div className="screen sidebar">
      <NavBar
        sidebar
        title="Projects"
        trailing={
          <>
            {browse}
            <NewSessionButton />
            <HomeMenu />
          </>
        }
      />
      <div className="scroll">
        <label className="search">
          <Icon name="search" size={13} />
          <input
            value={filter}
            placeholder="Filter sessions"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
        {model.state.machines.map((machine) => (
          <MachineProjects key={machine.id} machine={machine} query={query} />
        ))}
        {local?.host && !model.allProjects().length ? <p className="hint pad">No projects yet. Open a folder of a machine with the folder button.</p> : null}
      </div>
    </div>
  );
}

/** One machine's projects, under its name when several are shown. */
function MachineProjects({ machine, query }: { machine: MachineState; query: string }) {
  const model = useModel();
  const projects = model.visibleProjects(machine.id);
  if (!model.multi()) return projects.map((project) => <ProjectSection key={project.id} project={project} query={query} />);
  return (
    <>
      <div className="machine-label">
        <Icon name={machine.offline ? "offline" : "desktop"} size={13} className={machine.offline ? "amber" : "faint"} />
        <span className="ellipsis">{machine.name}</span>
        {machine.offline ? <span className="meta amber">unreachable</span> : null}
      </div>
      {projects.map((project) => (
        <ProjectSection key={project.id} project={project} query={query} />
      ))}
      {!projects.length && machine.host ? <div className="no-sessions">No projects</div> : null}
    </>
  );
}

function ProjectSection({ project, query }: { project: MachineProject; query: string }) {
  const model = useModel();
  const all = model.machine(project.machineId)?.sessions[project.id] ?? [];
  const list = all
    .filter((s) => !isDraftOnly(s) && (model.state.showArchived || !s.archived))
    .filter((s) => !query || displayTitle(s.title, s.harness).toLowerCase().includes(query) || project.name.toLowerCase().includes(query))
    .sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || b.updatedAt - a.updatedAt);
  if (query && !list.length) return null;
  const open = model.isProjectOpen(project) || !!query;
  const newSession = () => model.push({ kind: "new", machineId: project.machineId, projectId: project.id });
  const menu: MenuItem[] = [
    { label: "New session", icon: "plus", run: newSession },
    { kind: "text", label: tilde(project.cwd) },
    ...(model.can("projects.rail", project.machineId) ? [{ label: "Remove from list", danger: true, run: () => void model.hide(project) } satisfies MenuItem] : []),
  ];
  return (
    <>
      <div className="project-row">
        <button className="project-toggle" aria-label={`${project.name}, ${open ? "open" : "folded"}`} onClick={() => model.toggleProject(project)}>
          <Icon name={open ? "chevronDown" : "chevronRight"} size={11} className="faint" />
          <Mascot seed={folderName(project.cwd)} active={list.some(isRunning)} />
          <span className="project-name ellipsis">{project.name}</span>
          <ProjectStatusCounts sessions={all} />
        </button>
        <Menu className="row-button" ariaLabel={`${project.name} options`} label={<Icon name="ellipsis" size={15} />} items={menu} />
        <button className="row-button" aria-label="New session" onClick={newSession}>
          <Icon name="plus" size={15} />
        </button>
      </div>
      {open ? list.map((session) => <SessionLink key={rowKey(session)} session={session} />) : null}
      {open && !list.length ? <div className="no-sessions">No sessions</div> : null}
    </>
  );
}

/** A project's working and done sessions, beside its name. */
function ProjectStatusCounts({ sessions }: { sessions: MachineSession[] }) {
  const live = sessions.filter((s) => !s.archived && !isDraftOnly(s));
  const working = live.filter((s) => isRunning(s) && s.needsInput !== true).length;
  const waiting = live.filter((s) => s.needsInput === true).length;
  const done = live.filter(isDone).length;
  return (
    <span className="counts">
      {waiting ? (
        <span className="amber" aria-label={`${waiting} waiting for you`}>
          <Icon name="exclamation" size={10} />
          {waiting}
        </span>
      ) : null}
      {working ? (
        <span className="link" aria-label={`${working} working`}>
          <span className="dot" />
          {working}
        </span>
      ) : null}
      {done ? (
        <span className="add" aria-label={`${done} done, waiting to be checked`}>
          <Icon name="check" size={10} />
          {done}
        </span>
      ) : null}
    </span>
  );
}

/** The actions of a session, from a long press on its row or its screen's menu. */
export function sessionActions(session: MachineSession, options: { rename: boolean; onArchived?: () => void }): MenuItem[] {
  const model = appModel;
  const name = displayTitle(session.title, session.harness);
  const rename: MenuItem = {
    label: "Rename",
    icon: "pencil",
    run: () => model.set({ dialog: { kind: "prompt", title: "Rename session", initial: name, run: (title) => void model.update(session, { title }) } }),
  };
  const pin: MenuItem = { label: session.pinned ? "Unpin" : "Pin", icon: "pin", run: () => void model.update(session, { pinned: !session.pinned }) };
  return [
    ...(isDone(session) ? [{ label: "Mark checked", icon: "checkCircle", run: () => void model.markChecked(session) } satisfies MenuItem] : []),
    ...(options.rename ? [rename, pin] : [pin, rename]),
    {
      label: session.archived ? "Unarchive" : "Archive",
      icon: "archive",
      run: () => {
        void model.update(session, { archived: !session.archived });
        if (!session.archived) options.onArchived?.();
      },
    },
  ];
}

export function deleteAction(session: MachineSession): MenuItem {
  const model = appModel;
  const name = displayTitle(session.title, session.harness);
  return {
    label: "Delete",
    icon: "trash",
    danger: true,
    run: () =>
      model.set({
        dialog: {
          kind: "confirm",
          title: `Delete "${name}"? Its transcript is removed from ${model.machine(session.machineId)?.name ?? "the host"}.`,
          action: "Delete",
          run: () => void model.delete(session),
        },
      }),
  };
}

/** A session row that opens it, with its actions on a long press. */
export function SessionLink({ session, showProject }: { session: MachineSession; showProject?: boolean }) {
  const model = useModel();
  const { handlers, menu } = useContextMenu(() => [...sessionActions(session, { rename: false }), deleteAction(session)]);
  return (
    <>
      <button className="session-row" {...handlers} onClick={() => model.push(sessionRoute(session))}>
        <SessionRow session={session} showProject={showProject} />
      </button>
      {menu}
    </>
  );
}

/** One session as the IDE's sidebar shows it: agent and model, title,
 * branch; its project and machine where the list mixes them. */
function SessionRow({ session, showProject }: { session: MachineSession; showProject?: boolean }) {
  const model = useModel();
  const running = isRunning(session);
  const project = showProject ? model.project(session.machineId, session.projectId) : undefined;
  // Under a project the machine is already named by its section.
  const machine = showProject && model.multi() ? model.machine(session.machineId)?.name : undefined;
  const where = [project?.name, machine].filter(Boolean);
  return (
    <>
      <span className="row-line meta">
        <HarnessIcon harness={session.harness} size={13} />
        <span className="ellipsis">{model.modelName(session.machineId, session.harness, session.model)}</span>
        {where.map((part) => (
          <span key={part} className="row-line">
            <span>·</span>
            <span className="ellipsis">{part}</span>
          </span>
        ))}
        <span className="spacer" />
        {session.pinned ? <Icon name="pin" size={10} /> : null}
        <span className="mono-small">{ago(session.updatedAt)}</span>
      </span>
      <span className="row-line">
        <span className={`row-title ellipsis${session.archived ? " muted" : ""}${running ? " shimmer" : ""}`}>{displayTitle(session.title, session.harness)}</span>
        <span className="spacer" />
        {session.needsInput ? (
          <Pill text="Needs you" />
        ) : running ? (
          <Pill text="Working" color="var(--link)" />
        ) : isFailedTurn(session) ? (
          <Pill text="Failed" color="var(--del-fg)" />
        ) : isDone(session) ? (
          <Pill text="Done" color="var(--add-fg)" />
        ) : session.status === "interrupted" ? (
          <Pill text="Interrupted" color="var(--del-fg)" />
        ) : null}
      </span>
      {session.repo || session.branch ? (
        <span className="row-line branch">
          <Icon name="branch" size={11} />
          <span className="ellipsis">{[session.repo, session.branch].filter(Boolean).join("/")}</span>
        </span>
      ) : null}
    </>
  );
}

/** This page's host beside the app's logo and version; the number of
 * machines when there are several. */
function HostHeader() {
  const model = useModel();
  const host = model.machine(LOCAL)?.host;
  const count = model.state.machines.length;
  return (
    <button className="host-header" onClick={() => model.set({ sheet: { kind: "machines" } })} aria-label="Machines">
      <img src="side.png" alt="" width={20} height={20} />
      <span className="host-name ellipsis">{count > 1 ? `${count} machines` : (host?.name ?? "sIDE")}</span>
      {model.state.offline ? (
        <Icon name="offline" size={13} className="amber" />
      ) : host?.version ? (
        <span className="mono-small faint">{host.version}</span>
      ) : null}
    </button>
  );
}

/** A new session in the project worked in last. */
function NewSessionButton() {
  const model = useModel();
  const project = model.recentProject();
  if (!project) return null;
  return (
    <button className="bar-button" aria-label="New session" onClick={() => model.push({ kind: "new", machineId: project.machineId, projectId: project.id })}>
      <Icon name="compose" size={21} />
    </button>
  );
}

/** Everything that is not a session: machines, web apps, usage, notifications. */
function HomeMenu() {
  const model = useModel();
  const push = useNotifications();
  const local = model.machine(LOCAL);
  const apps = local?.webApps ?? [];
  const items = (): MenuItem[] => [
    // The desktop's web apps open in a tab of their own: a page can't frame them.
    ...(apps.length
      ? [
          { kind: "section", label: "Web apps" } as MenuItem,
          ...apps.map((app): MenuItem => ({ label: app.name, icon: "globe", run: () => void open(app.url, "_blank", "noopener,noreferrer") })),
          { kind: "divider" } as MenuItem,
        ]
      : []),
    ...(model.can("machines") ? [{ label: "Machines", icon: "desktop", run: () => model.set({ sheet: { kind: "machines" } }) } satisfies MenuItem] : []),
    { label: "Usage & accounts", icon: "gauge", run: () => model.set({ sheet: { kind: "usage" } }) },
    { label: "Show archived", checked: model.state.showArchived, run: () => model.setShowArchived(!model.state.showArchived) },
    ...(push.state === "on" || push.state === "off"
      ? [{ label: "Notifications", icon: "bell", checked: push.state === "on", run: () => void push.toggle() } satisfies MenuItem]
      : push.state === "install"
        ? [{ kind: "text", label: "Add to Home Screen for notifications" } as MenuItem]
        : push.state === "denied"
          ? [{ kind: "text", label: "Notifications are blocked in the browser" } as MenuItem]
          : []),
    { kind: "divider" },
    { kind: "section", label: `${location.host}${local?.host?.version ? ` · host ${local.host.version}` : ""}` },
    { label: "Sign out", danger: true, run: () => void model.signOut() },
  ];
  return <Menu ariaLabel="More" label={<Icon name="ellipsis" size={21} />} items={items} />;
}

/** The machines this page shows: this host, and the others it reaches. */
export function MachinesSheet() {
  const model = useModel();
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const canAdd = model.can("machines");
  const add = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      await model.addMachine(address, token);
      setAdding(false);
      setAddress("");
      setToken("");
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <NavBar
        sidebar
        title="Machines"
        trailing={
          <button className="bar-text strong" onClick={() => model.set({ sheet: undefined })}>
            Done
          </button>
        }
      />
      <div className="scroll sheet-scroll">
        <div className="accounts">
          {model.state.machines.map((machine) => (
            <div key={machine.id} className="card">
              <div className="row-line">
                <Icon name="desktop" size={15} />
                <span className="strong ellipsis">{machine.name}</span>
                <span className="spacer" />
                {machine.id === LOCAL ? <Pill text="This host" color="var(--muted)" /> : machine.offline ? <Pill text="Unreachable" /> : null}
              </div>
              <div className="meta muted ellipsis">
                {machine.id === LOCAL ? location.host : machine.url}
                {machine.host?.version ? ` · ${machine.host.version}` : ""}
              </div>
              {machine.error && machine.offline ? <div className="meta del clamp-2">{machine.error}</div> : null}
              {machine.id !== LOCAL ? (
                <div className="button-row">
                  <Button
                    onClick={() =>
                      model.set({
                        dialog: { kind: "prompt", title: "Rename machine", initial: machine.name, run: (name) => void model.renameMachine(machine.id, name) },
                      })
                    }
                  >
                    Rename
                  </Button>
                  <Button
                    danger
                    onClick={() =>
                      model.set({
                        dialog: {
                          kind: "confirm",
                          title: `Stop showing ${machine.name} here? Its sessions keep running on it.`,
                          action: "Remove",
                          run: () => void model.removeMachine(machine.id),
                        },
                      })
                    }
                  >
                    Remove
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
          {!canAdd ? (
            <p className="hint">Update this host to show other machines here.</p>
          ) : adding ? (
            <form
              className="card"
              onSubmit={(event) => {
                event.preventDefault();
                void add();
              }}
            >
              <div className="strong">Add a machine</div>
              <p className="small muted">
                On that machine, run <code>side-host pair --name Web --url &lt;its address&gt;</code> and paste the link, or its address and the credential.
              </p>
              <input className="field" value={address} placeholder="side://pair?… or https://machine.tailnet.ts.net" autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(event) => setAddress(event.target.value)} />
              {address.startsWith("side://") ? null : (
                <input className="field" type="password" value={token} placeholder="Device credential" autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(event) => setToken(event.target.value)} />
              )}
              {failure ? <div className="meta del">{failure}</div> : null}
              <div className="button-row">
                <button className="btn primary" disabled={busy || !address.trim()}>
                  {busy ? <Spinner size={13} /> : null}
                  Add
                </button>
                <Button onClick={() => setAdding(false)}>Cancel</Button>
              </div>
            </form>
          ) : (
            <div className="button-row">
              <Button icon="plus" onClick={() => setAdding(true)}>
                Add machine
              </Button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** The usage sheet of the home menu: every machine's accounts. */
export function UsageSheet() {
  const model = useModel();
  const [managing, setManaging] = useState<string>();
  if (managing) return <HostAccountsSheet machineId={managing} onDone={() => setManaging(undefined)} embedded />;
  return (
    <>
      <NavBar
        sidebar
        title="Usage"
        trailing={
          <button className="bar-text strong" onClick={() => model.set({ sheet: undefined })}>
            Done
          </button>
        }
      />
      <div className="scroll sheet-scroll">
        {model.state.machines.map((machine) => (
          <UsageView key={machine.id} machineId={machine.id} title={model.multi() ? machine.name : "Usage"} accounts={machine.accounts} onManage={() => setManaging(machine.id)} />
        ))}
      </div>
    </>
  );
}

/** Each account's 5-hour and 7-day usage, as the web sidebar's footer, with
 * its sign-in error or limit. Opens the host's accounts. */
function UsageView({ machineId, title, accounts, onManage }: { machineId: string; title: string; accounts: HostAccountSummary[]; onManage: () => void }) {
  const model = useModel();
  const named = accounts.filter((account) => !account.pool);
  useOnce(() => void model.refreshAccounts(machineId));
  if (!named.length && !model.can("accounts.login", machineId)) return null;
  return (
    <>
      <SectionLabel text={title}>
        <button className="link-button" onClick={onManage}>
          Accounts
        </button>
      </SectionLabel>
      <div className="usage-list">
        {named.map((account) => {
          const until = limitedUntil(account);
          return (
            <button key={account.id} className="usage-row" onClick={onManage}>
              <span className="row-line">
                <span className="meta muted ellipsis">{account.label}</span>
                <span className="spacer" />
                {account.usage?.fiveHour || account.usage?.sevenDay ? (
                  <>
                    <UsageBar used={account.usage?.fiveHour?.used} label="5h" />
                    <UsageBar used={account.usage?.sevenDay?.used} label="7d" />
                  </>
                ) : null}
              </span>
              {until ? <span className="meta amber">Limited until {resetTime(until)}</span> : null}
              {account.usage?.error ? <span className="meta del clamp-2">{account.usage.error}</span> : null}
            </button>
          );
        })}
      </div>
    </>
  );
}

function UsageBar({ used = 0, label }: { used?: number; label: string }) {
  return (
    <span className="usage-bar">
      <span className="mono-small faint">{label}</span>
      <span className="bar">
        <span style={{ width: `${Math.min(100, used)}%`, background: used >= 90 ? "var(--del)" : "var(--muted)" }} />
      </span>
    </span>
  );
}

function useOnce(run: () => void) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(run, []);
}
