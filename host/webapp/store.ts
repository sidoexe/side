import { useSyncExternalStore } from "react";
import { describe, LOCAL, logout, rpc, Unauthorized } from "./api";
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

/** A session or a project, with the machine whose host runs it. */
export type MachineSession = HostSessionSummary & { machineId: string };
export type MachineProject = HostProject & { machineId: string };

/** The other machines this page's host knows, as `machines.list` gives them. */
export type MachineEntry = { id: string; name: string; url: string; environmentId: string };

/** One machine: its own host, projects, sessions and accounts. Every machine
 * is the only engine for its sessions; the page only gathers them. */
export type MachineState = {
  id: string;
  name: string;
  url?: string;
  host?: HostDescriptor;
  projects: MachineProject[];
  sessions: Record<string, MachineSession[]>;
  accounts: HostAccountSummary[];
  /** The desktop's rail, when the host keeps one: its projects and order. */
  rail?: RailState;
  /** Every agent's models, for their display names. */
  catalog?: HostModelCatalog;
  /** The desktop's web apps, read once per host. */
  webApps?: HostWebApp[];
  /** The last read could not reach it; it keeps what it had. */
  offline: boolean;
  error?: string;
};

/** The tabs of the home screen, each with its own stack. */
export type HomeTab = "now" | "projects";

/** Every screen pushed over a tab. */
export type Route =
  | { kind: "session"; machineId: string; projectId: string; sessionId: string }
  | { kind: "new"; machineId: string; projectId: string }
  | { kind: "browse"; machineId: string };

export type Dialog =
  | { kind: "alert"; title: string; message: string }
  | { kind: "confirm"; title: string; action: string; run: () => void }
  | { kind: "prompt"; title: string; initial: string; run: (text: string) => void };

export type SheetState = { kind: "usage" } | { kind: "accounts"; machineId: string; provider?: string } | { kind: "machines" };

type State = {
  /** Signed in with the host's cookie: `undefined` until known. */
  signedIn?: boolean;
  /** This page's host first, then the others it knows. */
  machines: MachineState[];
  /** What this browser marked checked (`machine:session`), last checked first. */
  checks: string[];
  /** The last repeating read could not reach this page's host. */
  offline: boolean;
  tab: HomeTab;
  paths: Record<HomeTab, Route[]>;
  dialog?: Dialog;
  showArchived: boolean;
  /** The projects opened, as `machine:project`. */
  openProjects: string[];
  sheet?: SheetState;
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

const key = (machineId: string, id: string) => `${machineId}:${id}`;
const blank = (id: string, name: string, url?: string): MachineState => ({ id, name, url, projects: [], sessions: {}, accounts: [], offline: false });

/** The page's hash names the screen on top, so a notification or a reload
 * opens it: `#/s/<machine>/<project>/<session>`, `#/new/<machine>/<project>`,
 * `#/browse/<machine>`. A session link without a machine is this host's,
 * as its notifications write it. */
function routeFromHash(): { tab: HomeTab; route?: Route } {
  const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  const [kind] = parts;
  if (kind === "s" && parts.length >= 4) return { tab: "now", route: { kind: "session", machineId: parts[1], projectId: parts[2], sessionId: parts[3] } };
  if (kind === "s" && parts[1] && parts[2]) return { tab: "now", route: { kind: "session", machineId: LOCAL, projectId: parts[1], sessionId: parts[2] } };
  if (kind === "new" && parts[1] && parts[2]) return { tab: "projects", route: { kind: "new", machineId: parts[1], projectId: parts[2] } };
  if (kind === "browse") return { tab: "projects", route: { kind: "browse", machineId: parts[1] || LOCAL } };
  return { tab: kind === "projects" ? "projects" : "now" };
}

function hashOf(tab: HomeTab, route?: Route) {
  const e = encodeURIComponent;
  if (!route) return tab === "projects" ? "#/projects" : "#/";
  if (route.kind === "session") return `#/s/${e(route.machineId)}/${e(route.projectId)}/${e(route.sessionId)}`;
  if (route.kind === "new") return `#/new/${e(route.machineId)}/${e(route.projectId)}`;
  return `#/browse/${e(route.machineId)}`;
}

class AppModel {
  state: State;
  private listeners = new Set<() => void>();
  private pollFailures = 0;
  private accountsRefreshedAt = new Map<string, number>();

  constructor() {
    const initial = routeFromHash();
    this.state = {
      machines: [blank(LOCAL, "sIDE")],
      checks: stored<string[]>("home.checked.machines", []),
      offline: false,
      tab: initial.tab,
      paths: { now: [], projects: [], [initial.tab]: initial.route ? [initial.route] : [] },
      showArchived: stored("home.showArchived", false),
      openProjects: stored<string[]>("projects.open.machines", []),
    };
    // The browser's back pops the stack on screen.
    history.replaceState({ depth: this.path.length }, "", hashOf(this.state.tab, this.path.at(-1)));
    addEventListener("popstate", () => {
      if (this.path.length) this.setPath(this.path.slice(0, -1), false);
    });
    // A tapped notification points an open page at its session.
    addEventListener("hashchange", () => {
      const next = routeFromHash();
      if (!next.route) return;
      this.set({ tab: next.tab, paths: { ...this.state.paths, [next.tab]: [next.route] } });
      history.replaceState({ depth: 1 }, "", hashOf(next.tab, next.route));
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

  private setMachine(id: string, patch: Partial<MachineState>) {
    this.set({ machines: this.state.machines.map((m) => (m.id === id ? { ...m, ...patch } : m)) });
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
  reportPoll(error: unknown, machineId = LOCAL) {
    if (error instanceof Unauthorized) return this.report(error);
    if (machineId !== LOCAL) return this.setMachine(machineId, { offline: true, error: error instanceof Error ? error.message : String(error) });
    this.pollFailures += 1;
    if (error instanceof TypeError) this.set({ offline: true });
    else if (this.pollFailures === 3) this.report(error);
  }

  pollSucceeded(machineId = LOCAL) {
    if (machineId !== LOCAL) {
      if (this.machine(machineId)?.offline) this.setMachine(machineId, { offline: false, error: undefined });
      return;
    }
    this.pollFailures = 0;
    if (this.state.offline) this.set({ offline: false });
  }

  // MARK: Machines

  machine(id: string) {
    return this.state.machines.find((m) => m.id === id);
  }

  /** Whether the page shows several machines, and so names each one. */
  multi() {
    return this.state.machines.length > 1;
  }

  can(capability: string, machineId = LOCAL) {
    return this.machine(machineId)?.host?.capabilities.includes(capability) === true;
  }

  async signOut() {
    await logout().catch(() => undefined);
    this.set({ signedIn: false, machines: [blank(LOCAL, "sIDE")], paths: { now: [], projects: [] }, tab: "now", sheet: undefined });
    this.accountsRefreshedAt.clear();
    history.replaceState({ depth: 0 }, "", "#/");
  }

  /** This page's host, the machines it knows, and every one's sessions. */
  async refresh() {
    try {
      const local = this.machine(LOCAL)!;
      if (!local.host) {
        const host = await describe();
        this.setMachine(LOCAL, { host, name: host.name });
        this.set({ signedIn: true });
        const catalog = await rpc<HostModelCatalog>("models.list").catch(() => undefined);
        this.setMachine(LOCAL, { catalog });
      }
      if (this.can("machines")) {
        const entries = await rpc<MachineEntry[]>("machines.list").catch(() => undefined);
        if (entries) this.adoptMachines(entries);
      }
      await Promise.all(this.state.machines.map((m) => this.refreshMachine(m.id)));
    } catch (error) {
      if (error instanceof Unauthorized && !this.machine(LOCAL)?.host) return this.set({ signedIn: false });
      this.reportPoll(error);
    }
  }

  /** Keeps what is known of machines still listed, in the host's order. */
  private adoptMachines(entries: MachineEntry[]) {
    const known = new Map(this.state.machines.map((m) => [m.id, m]));
    const others = entries.map((entry) => {
      const machine = known.get(entry.id);
      return machine ? { ...machine, name: entry.name, url: entry.url } : blank(entry.id, entry.name, entry.url);
    });
    this.set({ machines: [known.get(LOCAL)!, ...others] });
  }

  /** One machine's projects, sessions, accounts and rail. */
  private async refreshMachine(machineId: string) {
    try {
      if (!this.machine(machineId)?.host) {
        const host = await describe(machineId);
        const catalog = await rpc<HostModelCatalog>("models.list", {}, machineId).catch(() => undefined);
        this.setMachine(machineId, { host, catalog });
      }
      const projects = (await rpc<HostProject[]>("projects.list", {}, machineId)).map((p) => ({ ...p, machineId }));
      // A project whose list fails keeps the last one it had: a folder
      // moved on the host must not hide every other session.
      const previous = this.machine(machineId)?.sessions ?? {};
      let failure: unknown;
      const lists = await Promise.all(
        projects.map((project) =>
          rpc<HostSessionSummary[]>("sessions.list", { projectId: project.id }, machineId).then(
            (list) => list.map((s) => ({ ...s, machineId })),
            (error: unknown) => {
              failure = error;
              return previous[project.id] ?? [];
            },
          ),
        ),
      );
      // The credential and the connection are not a project's fault.
      if (failure instanceof Unauthorized || failure instanceof TypeError) throw failure;
      const sessions: Record<string, MachineSession[]> = {};
      projects.forEach((project, index) => (sessions[project.id] = lists[index]));
      this.setMachine(machineId, { projects, sessions });
      const accounts = await rpc<HostAccountSummary[]>("accounts.list", {}, machineId).catch(() => this.machine(machineId)?.accounts ?? []);
      this.setMachine(machineId, { accounts });
      if (this.can("projects.rail", machineId)) {
        const rail = await rpc<RailState>("projects.rail", {}, machineId).catch(() => this.machine(machineId)?.rail);
        this.setMachine(machineId, { rail });
      }
      if (!this.machine(machineId)?.webApps && this.can("webApps", machineId)) {
        const apps = await rpc<{ apps: HostWebApp[] }>("webApps.get", {}, machineId).catch(() => undefined);
        if (apps) this.setMachine(machineId, { webApps: apps.apps });
      }
      this.pollSucceeded(machineId);
    } catch (error) {
      if (machineId === LOCAL) throw error;
      this.reportPoll(error, machineId);
    }
  }

  async addMachine(address: string, token: string) {
    const added = await rpc<MachineEntry>("machines.add", { address, token });
    this.adoptMachines(await rpc<MachineEntry[]>("machines.list"));
    await this.refreshMachine(added.id);
    return added;
  }

  async renameMachine(machineId: string, name: string) {
    try {
      this.adoptMachines(await rpc<MachineEntry[]>("machines.rename", { machineId, name }));
    } catch (error) {
      this.report(error);
    }
  }

  async removeMachine(machineId: string) {
    try {
      this.adoptMachines(await rpc<MachineEntry[]>("machines.remove", { machineId }));
      const drop = (routes: Route[]) => routes.filter((r) => r.machineId !== machineId);
      this.set({ paths: { now: drop(this.state.paths.now), projects: drop(this.state.paths.projects) } });
    } catch (error) {
      this.report(error);
    }
  }

  // MARK: Lists

  /** As the web app's `visibleProjects`: the rail's, in its order, when the
   * desktop sent one; otherwise every project but the archived ones. */
  visibleProjects(machineId: string): MachineProject[] {
    const machine = this.machine(machineId);
    if (!machine) return [];
    const { rail, projects } = machine;
    if (rail?.projects.length) {
      const byCwd = new Map(projects.map((project) => [project.cwd, project]));
      return rail.projects.flatMap((cwd) => byCwd.get(cwd) ?? []);
    }
    return projects.filter((project) => !rail?.archived.includes(project.cwd));
  }

  allProjects() {
    return this.state.machines.flatMap((m) => this.visibleProjects(m.id));
  }

  allSessions(): MachineSession[] {
    return this.state.machines.flatMap((m) => Object.values(m.sessions).flat());
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
    const all = new Map(this.allSessions().map((s) => [key(s.machineId, s.id), s]));
    return this.state.checks
      .flatMap((id) => all.get(id) ?? [])
      .filter((s) => !s.archived && !isRunning(s) && s.needsInput !== true && !isDone(s));
  }

  /** "Claude Opus 5" rather than "opus", from that machine's catalog. */
  modelName(machineId: string, harness: string, model?: string) {
    if (!model) return harness.charAt(0).toUpperCase() + harness.slice(1);
    const found = this.machine(machineId)?.catalog?.models[harness]?.find((item) => modelMatches(item, model));
    return found?.name ?? model.split(":").pop() ?? model;
  }

  summary(machineId: string, projectId: string, sessionId: string) {
    return this.machine(machineId)?.sessions[projectId]?.find((s) => s.id === sessionId);
  }

  project(machineId: string, id: string) {
    return this.machine(machineId)?.projects.find((project) => project.id === id);
  }

  /** The machine that runs a session, for a link that does not say. */
  machineOf(sessionId: string) {
    return this.allSessions().find((s) => s.id === sessionId)?.machineId;
  }

  isProjectOpen(project: MachineProject) {
    return this.state.openProjects.includes(key(project.machineId, project.id));
  }

  toggleProject(project: MachineProject) {
    const id = key(project.machineId, project.id);
    const open = this.state.openProjects.includes(id) ? this.state.openProjects.filter((item) => item !== id) : [...this.state.openProjects, id];
    store("projects.open.machines", open);
    this.set({ openProjects: open });
  }

  // MARK: Session actions

  async markChecked(summary: MachineSession) {
    const id = key(summary.machineId, summary.id);
    const checks = [id, ...this.state.checks.filter((item) => item !== id)].slice(0, 50);
    store("home.checked.machines", checks);
    this.set({ checks });
    await this.update(summary, { reviewed: true });
  }

  async update(summary: MachineSession, patch: Record<string, unknown>) {
    try {
      await rpc("sessions.update", { ...patch, projectId: summary.projectId, sessionId: summary.id }, summary.machineId);
      await this.refreshMachine(summary.machineId);
    } catch (error) {
      this.report(error);
    }
  }

  async delete(summary: MachineSession) {
    try {
      await rpc("sessions.delete", { projectId: summary.projectId, sessionId: summary.id }, summary.machineId);
      const keep = (r: Route) => !(r.kind === "session" && r.sessionId === summary.id && r.machineId === summary.machineId);
      this.set({ paths: { now: this.state.paths.now.filter(keep), projects: this.state.paths.projects.filter(keep) } });
      history.replaceState({ depth: this.path.length }, "", hashOf(this.state.tab, this.path.at(-1)));
      await this.refreshMachine(summary.machineId);
    } catch (error) {
      this.report(error);
    }
  }

  // MARK: Projects

  async setRail(machineId: string, projects: string[], archived: string[]) {
    try {
      this.setMachine(machineId, { rail: await rpc<RailState>("projects.setRail", { projects, archived }, machineId) });
    } catch (error) {
      this.report(error);
    }
  }

  /** Opens a folder of a machine as a project and lists it, as the desktop's rail does. */
  async openProject(machineId: string, cwd: string) {
    try {
      const opened: MachineProject = { ...(await rpc<HostProject>("projects.open", { cwd }, machineId)), machineId };
      const machine = this.machine(machineId)!;
      if (!machine.projects.some((p) => p.id === opened.id)) this.setMachine(machineId, { projects: [...machine.projects, opened] });
      const { rail } = machine;
      const visible = this.visibleProjects(machineId);
      if (rail && !visible.some((p) => p.cwd === opened.cwd))
        await this.setRail(machineId, [...visible.map((p) => p.cwd), opened.cwd], rail.archived.filter((cwd) => cwd !== opened.cwd));
      return opened;
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }

  async hide(project: MachineProject) {
    const machine = this.machine(project.machineId);
    await this.setRail(
      project.machineId,
      this.visibleProjects(project.machineId).map((p) => p.cwd).filter((cwd) => cwd !== project.cwd),
      [project.cwd, ...(machine?.rail?.archived ?? [])],
    );
  }

  setShowArchived(on: boolean) {
    store("home.showArchived", on);
    this.set({ showArchived: on });
  }

  /** A new session in the project worked in last. */
  recentProject(): MachineProject | undefined {
    const latest = this.allSessions().reduce<MachineSession | undefined>((a, b) => (!a || b.updatedAt > a.updatedAt ? b : a), undefined);
    const visible = this.allProjects();
    return visible.find((p) => p.id === latest?.projectId && p.machineId === latest?.machineId) ?? visible[0];
  }

  // MARK: Host accounts

  /** Asks a host to read every account's usage afresh, as the desktop
   * does when its account menu opens: at most every 20 seconds. */
  async refreshAccounts(machineId = LOCAL, force = false) {
    if (!force && Date.now() - (this.accountsRefreshedAt.get(machineId) ?? 0) < 20_000) return;
    this.accountsRefreshedAt.set(machineId, Date.now());
    await this.changeAccounts(machineId, this.can("accounts.refresh", machineId) ? "accounts.refresh" : "accounts.list");
  }

  /** An account call that answers with the accounts after it. */
  async changeAccounts(machineId: string, method: string, params: Record<string, unknown> = {}) {
    try {
      this.setMachine(machineId, { accounts: await rpc<HostAccountSummary[]>(method, params, machineId) });
    } catch (error) {
      this.report(error);
    }
  }

  /** Whether a host can sign in an account of this provider from here:
   * Claude with `accounts.login`, Codex with `accounts.login.codex` as well. */
  canSignIn(machineId: string, provider: string) {
    if (!this.can("accounts.login", machineId)) return false;
    return provider === "claude" || (provider === "codex" && this.can("accounts.login.codex", machineId));
  }
}

export const model = new AppModel();

/** Re-renders on every change of the model, as SwiftUI's observation does. */
export function useModel() {
  useSyncExternalStore(model.subscribe, () => model.state);
  return model;
}
