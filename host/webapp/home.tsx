import { useEffect, useState } from "react";
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
  type HostProject,
  type HostSessionSummary,
} from "./model";
import { model as appModel, useModel, type Route } from "./store";
import { HarnessIcon, Icon, Mascot, Menu, NavBar, Pill, SectionLabel, useContextMenu, type MenuItem } from "./ui";
import { useNotifications } from "./push";
import { HostAccountsSheet } from "./accounts";

const sessionRoute = (s: HostSessionSummary): Route => ({ kind: "session", projectId: s.projectId, sessionId: s.id });

/** What needs you, across every project: to review, working, checked. */
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
        {toReview.length ? <SectionLabel text="To review" /> : null}
        {toReview.map((session) => (
          <div key={session.id} className="review-row">
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
          <SessionLink key={session.id} session={session} showProject />
        ))}
        {model.state.host && !toReview.length && !working.length ? (
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
                  <div key={session.id} className="faded">
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

/** Every project of the rail, folded to its counts until opened. */
export function ProjectsView() {
  const model = useModel();
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();
  const { host, projects } = model.state;
  return (
    <div className="screen sidebar">
      <NavBar
        sidebar
        title="Projects"
        trailing={
          <>
            {model.can("projects.browse") ? (
              <button className="bar-button" aria-label="Open folder" onClick={() => model.push({ kind: "browse" })}>
                <Icon name="folderPlus" size={21} />
              </button>
            ) : null}
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
        {model.visibleProjects().map((project) => (
          <ProjectSection key={project.id} project={project} query={query} />
        ))}
        {host && !projects.length ? <p className="hint pad">No projects yet. Open a folder of the host with the folder button.</p> : null}
      </div>
    </div>
  );
}

function ProjectSection({ project, query }: { project: HostProject; query: string }) {
  const model = useModel();
  const all = model.state.sessions[project.id] ?? [];
  const list = all
    .filter((s) => !isDraftOnly(s) && (model.state.showArchived || !s.archived))
    .filter(
      (s) =>
        !query ||
        displayTitle(s.title, s.harness).toLowerCase().includes(query) ||
        project.name.toLowerCase().includes(query),
    )
    .sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || b.updatedAt - a.updatedAt);
  if (query && !list.length) return null;
  const open = model.state.openProjects.includes(project.id) || !!query;
  const menu: MenuItem[] = [
    { label: "New session", icon: "plus", run: () => model.push({ kind: "new", projectId: project.id }) },
    { kind: "text", label: tilde(project.cwd) },
    ...(model.can("projects.rail")
      ? [{ label: "Remove from list", danger: true, run: () => void model.hide(project) } satisfies MenuItem]
      : []),
  ];
  return (
    <>
      <div className="project-row">
        <button className="project-toggle" aria-label={`${project.name}, ${open ? "open" : "folded"}`} onClick={() => model.toggleProject(project.id)}>
          <Icon name={open ? "chevronDown" : "chevronRight"} size={11} className="faint" />
          <Mascot seed={folderName(project.cwd)} active={list.some(isRunning)} />
          <span className="project-name ellipsis">{project.name}</span>
          <ProjectStatusCounts sessions={all} />
        </button>
        <Menu className="row-button" ariaLabel={`${project.name} options`} label={<Icon name="ellipsis" size={15} />} items={menu} />
        <button className="row-button" aria-label="New session" onClick={() => model.push({ kind: "new", projectId: project.id })}>
          <Icon name="plus" size={15} />
        </button>
      </div>
      {open ? list.map((session) => <SessionLink key={session.id} session={session} />) : null}
      {open && !list.length ? <div className="no-sessions">No sessions</div> : null}
    </>
  );
}

/** A project's working and done sessions, beside its name. */
function ProjectStatusCounts({ sessions }: { sessions: HostSessionSummary[] }) {
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
export function sessionActions(session: HostSessionSummary, options: { rename: boolean; onArchived?: () => void }): MenuItem[] {
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

export function deleteAction(session: HostSessionSummary): MenuItem {
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
          title: `Delete "${name}"? Its transcript is removed from the host.`,
          action: "Delete",
          run: () => void model.delete(session),
        },
      }),
  };
}

/** A session row that opens it, with its actions on a long press. */
export function SessionLink({ session, showProject }: { session: HostSessionSummary; showProject?: boolean }) {
  const model = useModel();
  const { handlers, menu } = useContextMenu(() => [...sessionActions(session, { rename: false }), deleteAction(session)]);
  return (
    <>
      <button className="session-row" {...handlers} onClick={() => model.push(sessionRoute(session))}>
        <SessionRow session={session} project={showProject ? model.project(session.projectId) : undefined} />
      </button>
      {menu}
    </>
  );
}

/** One session as the IDE's sidebar shows it: agent and model, title, branch. */
function SessionRow({ session, project }: { session: HostSessionSummary; project?: HostProject }) {
  const model = useModel();
  const running = isRunning(session);
  return (
    <>
      <span className="row-line meta">
        <HarnessIcon harness={session.harness} size={13} />
        <span className="ellipsis">{model.modelName(session.harness, session.model)}</span>
        {project ? (
          <>
            <span>·</span>
            <span className="ellipsis">{project.name}</span>
          </>
        ) : null}
        <span className="spacer" />
        {session.pinned ? <Icon name="pin" size={10} /> : null}
        <span className="mono-small">{ago(session.updatedAt)}</span>
      </span>
      <span className="row-line">
        <span className={`row-title ellipsis${session.archived ? " muted" : ""}${running ? " shimmer" : ""}`}>
          {displayTitle(session.title, session.harness)}
        </span>
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

/** The host's name beside the app's logo and version. */
function HostHeader() {
  const model = useModel();
  const { host, offline } = model.state;
  return (
    <div className="host-header">
      <img src="side.png" alt="" width={20} height={20} />
      <span className="host-name ellipsis">{host?.name ?? "sIDE"}</span>
      {offline ? (
        <Icon name="offline" size={13} className="amber" />
      ) : host?.version ? (
        <span className="mono-small faint">{host.version}</span>
      ) : null}
    </div>
  );
}

/** A new session in the project worked in last. */
function NewSessionButton() {
  const model = useModel();
  const project = model.recentProject();
  if (!project) return null;
  return (
    <button className="bar-button" aria-label="New session" onClick={() => model.push({ kind: "new", projectId: project.id })}>
      <Icon name="compose" size={21} />
    </button>
  );
}

/** Everything that is not a session: web apps, usage, notifications, the host. */
function HomeMenu() {
  const model = useModel();
  const push = useNotifications(model.can("push"));
  const apps = model.state.webApps ?? [];
  const items = (): MenuItem[] => [
    // The desktop's web apps open in a tab of their own: a page can't frame them.
    ...(apps.length
      ? [
          { kind: "section", label: "Web apps" } as MenuItem,
          ...apps.map((app): MenuItem => ({ label: app.name, icon: "globe", run: () => void open(app.url, "_blank", "noopener,noreferrer") })),
          { kind: "divider" } as MenuItem,
        ]
      : []),
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
    { kind: "section", label: `${location.host}${model.state.host?.version ? ` · host ${model.state.host.version}` : ""}` },
    { label: "Sign out", danger: true, run: () => void model.signOut() },
  ];
  return <Menu ariaLabel="More" label={<Icon name="ellipsis" size={21} />} items={items} />;
}

/** The usage sheet of the home menu. */
export function UsageSheet() {
  const model = useModel();
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
        <UsageView accounts={model.state.accounts} />
      </div>
    </>
  );
}

/** Each account's 5-hour and 7-day usage, as the web sidebar's footer, with
 * its sign-in error or limit. Opens the host's accounts. */
function UsageView({ accounts }: { accounts: HostAccountSummary[] }) {
  const model = useModel();
  const [managing, setManaging] = useState(false);
  const named = accounts.filter((account) => !account.pool);
  useOnce(() => void model.refreshAccounts());
  if (!named.length && !model.can("accounts.login")) return <p className="hint pad">No named accounts on this host.</p>;
  if (managing) return <HostAccountsSheet onDone={() => setManaging(false)} embedded />;
  return (
    <>
      <SectionLabel text="Usage">
        <button className="link-button" onClick={() => setManaging(true)}>
          Accounts
        </button>
      </SectionLabel>
      <div className="usage-list">
        {named.map((account) => {
          const until = limitedUntil(account);
          return (
            <button key={account.id} className="usage-row" onClick={() => setManaging(true)}>
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
