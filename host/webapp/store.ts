import { useSyncExternalStore } from "react";
import { describe, logout, rpc, Unauthorized } from "./api";
import {
  isDone,
  isDraftOnly,
  isFailedTurn,
  isRunning,
  modelMatches,
  type HostAccountSummary,
  type HostDescriptor,
  type HostModelCatalog,
  type HostProject,
  type HostSessionSummary,
  type HostWebApp,
  type RailState,
} from "./model";

/** The tabs of the home screen, each with its own stack. */
export type HomeTab = "now" | "projects";

/** Every screen pushed over a tab. */
export type Route =
  | { kind: "session"; projectId: string; sessionId: string }
  | { kind: "new"; projectId: string }
  | { kind: "browse" };

export type Dialog =
  | { kind: "alert"; title: string; message: string }
  | { kind: "confirm"; title: string; action: string; run: () => void }
  | { kind: "prompt"; title: string; initial: string; run: (text: string) => void };

type State = {
  /** Signed in with the host's cookie: `undefined` until known. */
  signedIn?: boolean;
  host?: HostDescriptor;
  projects: HostProject[];
  sessions: Record<string, HostSessionSummary[]>;
  accounts: HostAccountSummary[];
  /** The desktop's rail, when the host keeps one: its projects and order. */
  rail?: RailState;
  /** Every agent's models, for their display names. */
  catalog?: HostModelCatalog;
  /** What this phone marked checked, last checked first. */
  checks: string[];
  /** The desktop's web apps, read once per host. */
  webApps?: HostWebApp[];
  /** The last repeating read could not reach the host. */
  offline: boolean;
  tab: HomeTab;
  paths: Record<HomeTab, Route[]>;
  dialog?: Dialog;
  showArchived: boolean;
  openProjects: string[];
  /** A sheet over everything: usage, or the host's accounts. */
  sheet?: { kind: "usage" } | { kind: "accounts"; provider?: string };
};

const stored = <T>(key: string, fallback: T): T => {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : (JSON.parse(value) as T);
  } catch {
    return fallback;
  }
};
export const store = <T>(key: string, value: T) => localStorage.setItem(key, JSON.stringify(value));

/** The page's hash names the screen on top, so a notification or a reload
 * opens it: `#/s/<project>/<session>`, `#/new/<project>`, `#/browse`. */
function routeFromHash(): { tab: HomeTab; route?: Route } {
  const [kind, a, b] = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (kind === "s" && a && b) return { tab: "now", route: { kind: "session", projectId: a, sessionId: b } };
  if (kind === "new" && a) return { tab: "projects", route: { kind: "new", projectId: a } };
  if (kind === "browse") return { tab: "projects", route: { kind: "browse" } };
  return { tab: kind === "projects" ? "projects" : "now" };
}

function hashOf(tab: HomeTab, route?: Route) {
  if (!route) return tab === "projects" ? "#/projects" : "#/";
  if (route.kind === "session") return `#/s/${encodeURIComponent(route.projectId)}/${encodeURIComponent(route.sessionId)}`;
  if (route.kind === "new") return `#/new/${encodeURIComponent(route.projectId)}`;
  return "#/browse";
}

class AppModel {
  state: State;
  private listeners = new Set<() => void>();
  private pollFailures = 0;
  private accountsRefreshedAt = 0;

  constructor() {
    const initial = routeFromHash();
    this.state = {
      projects: [],
      sessions: {},
      accounts: [],
      checks: stored<string[]>("home.checked", []),
      offline: false,
      tab: initial.tab,
      paths: { now: [], projects: [], [initial.tab]: initial.route ? [initial.route] : [] },
      showArchived: stored("home.showArchived", false),
      openProjects: stored<string[]>("projects.open", []),
    };
    // The browser's back pops the stack on screen.
    history.replaceState({ depth: this.path.length }, "", hashOf(this.state.tab, this.path.at(-1)));
    addEventListener("popstate", () => {
      if (this.path.length) this.setPath(this.path.slice(0, -1), false);
    });
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  // MARK: Navigation

  get path() {
    return this.state.paths[this.state.tab];
  }

  private setPath(path: Route[], record = true) {
    this.set({ paths: { ...this.state.paths, [this.state.tab]: path } });
    if (record) history.replaceState({ depth: path.length }, "", hashOf(this.state.tab, path.at(-1)));
  }

  push(route: Route) {
    this.set({ paths: { ...this.state.paths, [this.state.tab]: [...this.path, route] } });
    history.pushState({ depth: this.path.length }, "", hashOf(this.state.tab, route));
  }

  /** Back one screen, as the bar's back button. */
  pop() {
    if (!this.path.length) return;
    if ((history.state as { depth?: number } | null)?.depth === this.path.length) history.back();
    else this.setPath(this.path.slice(0, -1));
  }

  /** The top screen gives way to another, as a new session to its session. */
  replace(route: Route) {
    this.setPath([...this.path.slice(0, -1), route]);
  }

  reset(path: Route[] = []) {
    this.setPath(path);
  }

  selectTab(tab: HomeTab) {
    if (tab === this.state.tab) {
      // Tapping the tab on screen goes back to its root, as on iOS.
      if (this.path.length) this.setPath([]);
      return;
    }
    this.set({ tab });
    history.replaceState({ depth: this.path.length }, "", hashOf(tab, this.path.at(-1)));
  }

  /** A tapped notification opens its session. */
  open(projectId: string, sessionId: string) {
    this.set({ tab: "now" });
    this.setPath([{ kind: "session", projectId, sessionId }]);
  }

  // MARK: Errors

  report(error: unknown) {
    if (error instanceof Unauthorized) {
      void this.signOut();
      this.alert("Host", "This browser was signed out of the host. Sign in again.");
    } else if (!(error instanceof DOMException && error.name === "AbortError")) {
      this.alert("Host", error instanceof Error ? error.message : String(error));
    }
  }

  alert(title: string, message: string) {
    this.set({ dialog: { kind: "alert", title, message } });
  }

  /** For reads that repeat on their own. A phone sleeps and changes network,
   * so a dropped request waits for the next read instead of raising an
   * alert; a host that keeps refusing is reported once, after three in a row. */
  reportPoll(error: unknown) {
    if (error instanceof Unauthorized) return this.report(error);
    this.pollFailures += 1;
    if (error instanceof TypeError) this.set({ offline: true });
    else if (this.pollFailures === 3) this.report(error);
  }

  pollSucceeded() {
    this.pollFailures = 0;
    if (this.state.offline) this.set({ offline: false });
  }

  // MARK: Host

  can(capability: string) {
    return this.state.host?.capabilities.includes(capability) === true;
  }

  async signOut() {
    await logout().catch(() => undefined);
    this.set({
      signedIn: false,
      host: undefined,
      projects: [],
      sessions: {},
      rail: undefined,
      accounts: [],
      catalog: undefined,
      webApps: undefined,
      paths: { now: [], projects: [] },
      tab: "now",
      sheet: undefined,
    });
    this.accountsRefreshedAt = 0;
    history.replaceState({ depth: 0 }, "", "#/");
  }

  /** The host, its projects and their sessions. */
  async refresh() {
    try {
      let host = this.state.host;
      if (!host) {
        host = await describe();
        this.set({ host, signedIn: true });
        const catalog = await rpc<HostModelCatalog>("models.list").catch(() => undefined);
        this.set({ catalog });
      }
      const projects = await rpc<HostProject[]>("projects.list");
      // A project whose list fails keeps the last one it had: a folder
      // moved on the host must not hide every other session.
      const previous = this.state.sessions;
      let failure: unknown;
      const lists = await Promise.all(
        projects.map((project) =>
          rpc<HostSessionSummary[]>("sessions.list", { projectId: project.id }).catch((error: unknown) => {
            failure = error;
            return previous[project.id] ?? [];
          }),
        ),
      );
      // The credential and the connection are not a project's fault.
      if (failure instanceof Unauthorized || failure instanceof TypeError) throw failure;
      const sessions: Record<string, HostSessionSummary[]> = {};
      projects.forEach((project, index) => (sessions[project.id] = lists[index]));
      this.set({ projects, sessions });
      const accounts = await rpc<HostAccountSummary[]>("accounts.list").catch(() => this.state.accounts);
      this.set({ accounts });
      if (this.can("projects.rail")) {
        const rail = await rpc<RailState>("projects.rail").catch(() => this.state.rail);
        this.set({ rail });
      }
      if (!this.state.webApps && this.can("webApps")) {
        const apps = await rpc<{ apps: HostWebApp[] }>("webApps.get").catch(() => undefined);
        if (apps) this.set({ webApps: apps.apps });
      }
      this.pollSucceeded();
    } catch (error) {
      if (error instanceof Unauthorized && !this.state.host) return this.set({ signedIn: false });
      this.reportPoll(error);
    }
  }

  /** As the web app's `visibleProjects`: the rail's, in its order, when the
   * desktop sent one; otherwise every project but the archived ones. */
  visibleProjects(): HostProject[] {
    const { rail, projects } = this.state;
    if (rail?.projects.length) {
      const byCwd = new Map(projects.map((project) => [project.cwd, project]));
      return rail.projects.flatMap((cwd) => byCwd.get(cwd) ?? []);
    }
    return projects.filter((project) => !rail?.archived.includes(project.cwd));
  }

  allSessions() {
    return Object.values(this.state.sessions).flat();
  }

  /** What waits on the user, as the desktop's To review: questions first,
   * then turns that failed, then done ones to check, each by recency. */
  toReview() {
    const rank = (s: HostSessionSummary) => (s.needsInput ? 0 : isFailedTurn(s) ? 1 : 2);
    return this.allSessions()
      .filter((s) => !s.archived && !isDraftOnly(s) && (s.needsInput === true || isDone(s)))
      .sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
  }

  /** Sessions still working, newest first. */
  working() {
    return this.allSessions()
      .filter((s) => !s.archived && isRunning(s) && s.needsInput !== true)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Sessions checked on this phone, last checked first. One that works,
   * waits or is done again leaves the list until it is checked again. */
  checked() {
    const all = new Map(this.allSessions().map((s) => [s.id, s]));
    return this.state.checks
      .flatMap((id) => all.get(id) ?? [])
      .filter((s) => !s.archived && !isRunning(s) && s.needsInput !== true && !isDone(s));
  }

  /** "Claude Opus 5" rather than "opus". */
  modelName(harness: string, model?: string) {
    if (!model) return harness.charAt(0).toUpperCase() + harness.slice(1);
    const found = this.state.catalog?.models[harness]?.find((item) => modelMatches(item, model));
    return found?.name ?? model.split(":").pop() ?? model;
  }

  summary(projectId: string, sessionId: string) {
    return this.state.sessions[projectId]?.find((s) => s.id === sessionId);
  }

  project(id: string) {
    return this.state.projects.find((project) => project.id === id);
  }

  async markChecked(summary: HostSessionSummary) {
    const checks = [summary.id, ...this.state.checks.filter((id) => id !== summary.id)].slice(0, 50);
    store("home.checked", checks);
    this.set({ checks });
    await this.update(summary, { reviewed: true });
  }

  async update(summary: HostSessionSummary, patch: Record<string, unknown>) {
    try {
      await rpc("sessions.update", { ...patch, projectId: summary.projectId, sessionId: summary.id });
      await this.refresh();
    } catch (error) {
      this.report(error);
    }
  }

  async delete(summary: HostSessionSummary) {
    try {
      await rpc("sessions.delete", { projectId: summary.projectId, sessionId: summary.id });
      const paths = {
        now: this.state.paths.now.filter((r) => !(r.kind === "session" && r.sessionId === summary.id)),
        projects: this.state.paths.projects.filter((r) => !(r.kind === "session" && r.sessionId === summary.id)),
      };
      this.set({ paths });
      history.replaceState({ depth: this.path.length }, "", hashOf(this.state.tab, this.path.at(-1)));
      await this.refresh();
    } catch (error) {
      this.report(error);
    }
  }

  async setRail(projects: string[], archived: string[]) {
    try {
      this.set({ rail: await rpc<RailState>("projects.setRail", { projects, archived }) });
    } catch (error) {
      this.report(error);
    }
  }

  /** Opens a host folder as a project and lists it, as the desktop's rail does. */
  async openProject(cwd: string) {
    try {
      const opened = await rpc<HostProject>("projects.open", { cwd });
      if (!this.state.projects.some((p) => p.id === opened.id)) this.set({ projects: [...this.state.projects, opened] });
      const { rail } = this.state;
      if (rail && !this.visibleProjects().some((p) => p.cwd === opened.cwd))
        await this.setRail([...this.visibleProjects().map((p) => p.cwd), opened.cwd], rail.archived.filter((cwd) => cwd !== opened.cwd));
      return opened;
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }

  async hide(project: HostProject) {
    await this.setRail(
      this.visibleProjects().map((p) => p.cwd).filter((cwd) => cwd !== project.cwd),
      [project.cwd, ...(this.state.rail?.archived ?? [])],
    );
  }

  setShowArchived(on: boolean) {
    store("home.showArchived", on);
    this.set({ showArchived: on });
  }

  toggleProject(id: string) {
    const open = this.state.openProjects.includes(id)
      ? this.state.openProjects.filter((item) => item !== id)
      : [...this.state.openProjects, id];
    store("projects.open", open);
    this.set({ openProjects: open });
  }

  // MARK: Host accounts

  /** Asks the host to read every account's usage afresh, as the desktop
   * does when its account menu opens: at most every 20 seconds. */
  async refreshAccounts(force = false) {
    if (!force && Date.now() - this.accountsRefreshedAt < 20_000) return;
    this.accountsRefreshedAt = Date.now();
    await this.changeAccounts(this.can("accounts.refresh") ? "accounts.refresh" : "accounts.list");
  }

  /** An account call that answers with the accounts after it. */
  async changeAccounts(method: string, params: Record<string, unknown> = {}) {
    try {
      this.set({ accounts: await rpc<HostAccountSummary[]>(method, params) });
    } catch (error) {
      this.report(error);
    }
  }

  /** Whether the host can sign in an account of this provider from here:
   * Claude with `accounts.login`, Codex with `accounts.login.codex` as well. */
  canSignIn(provider: string) {
    if (!this.can("accounts.login")) return false;
    return provider === "claude" || (provider === "codex" && this.can("accounts.login.codex"));
  }

  /** A new session in the project worked in last. */
  recentProject() {
    const latest = this.allSessions().reduce<HostSessionSummary | undefined>((a, b) => (!a || b.updatedAt > a.updatedAt ? b : a), undefined);
    const visible = this.visibleProjects();
    return visible.find((p) => p.id === latest?.projectId) ?? visible[0];
  }
}

export const model = new AppModel();

/** Re-renders on every change of the model, as SwiftUI's observation does. */
export function useModel() {
  useSyncExternalStore(model.subscribe, () => model.state);
  return model;
}
