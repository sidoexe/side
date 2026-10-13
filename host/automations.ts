import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Automations on the home machine, so every desktop lists the same ones and
 * each occurrence runs once. Mirrors `src-tauri/src/automations.rs`: the
 * desktops still compute schedules and launch the sessions, and the host is
 * the single place where an occurrence or an Inbox event is claimed. The
 * claim is a conditional write, so of several desktops polling at once only
 * one gets a run back.
 *
 * Each run remembers the desktop that claimed it. After a restart a desktop
 * recovers only its own runs: another desktop's running turn is not
 * interrupted, and its pending launch is not taken over.
 */

const MAX_NAME = 200;
const MAX_PROMPT = 1_000_000;
const MAX_TRIGGERS = 20;
const MAX_RUNS_PER_AUTOMATION = 100;
const ID = /^[A-Za-z0-9._:-]{1,200}$/;
const KINDS = ["time", "github", "linear", "jira", "gitlab", "azuredevops"];
const EVENT_KINDS = KINDS.slice(1);
const SCHEDULES = ["hourly", "daily", "weekdays", "weekly"];
const RUN_STATUSES = ["pending", "running", "succeeded", "failed", "skipped", "cancelled"];
const DONE = ["succeeded", "failed", "skipped", "cancelled"];

type Json = Record<string, any>;
export type HostAutomation = Json & { id: string; enabled: boolean; nextRunAt: number };
export type HostAutomationRun = Json & {
  id: string;
  automationId: string;
  status: string;
  createdAt: number;
  claimedBy?: string;
};
export type DueRun = { automation: HostAutomation; run: HostAutomationRun };

function id(value: unknown, what: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`Invalid ${what} ID`);
  return value;
}

function validTime(value: unknown): boolean {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function int(value: unknown, min: number, max: number): boolean {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function validateTrigger(trigger: Json): void {
  if (!KINDS.includes(trigger.kind)) throw new Error("Invalid automation trigger.");
  const repos: unknown[] = Array.isArray(trigger.repos) ? trigger.repos : [];
  if (
    str(trigger.event).length > 200 ||
    str(trigger.repo).length > 400 ||
    str(trigger.branch).length > 400 ||
    str(trigger.actor).length > 200 ||
    repos.length > 50 ||
    repos.some((repo) => str(repo).length > 400)
  )
    throw new Error("Invalid automation trigger event.");
  if (!SCHEDULES.includes(trigger.scheduleKind ?? "weekdays"))
    throw new Error("Invalid automation schedule.");
  if (
    !int(trigger.minute ?? 0, 0, 59) ||
    !int(trigger.dayOfWeek ?? 1, 0, 6) ||
    !validTime(trigger.time ?? "09:00")
  )
    throw new Error("Invalid automation time.");
}

function validate(input: Json, now: number, imported: boolean): void {
  id(input.id, "automation");
  if (!str(input.name).trim() || str(input.name).length > MAX_NAME)
    throw new Error("Automation name is required and must be under 200 characters.");
  if (!str(input.prompt).trim() || str(input.prompt).length > MAX_PROMPT)
    throw new Error("Automation prompt is required.");
  if (!str(input.cwd).trim()) throw new Error("Choose a project for this automation.");
  if (!["current", "worktree", "existing"].includes(input.workspaceMode))
    throw new Error("Invalid automation workspace mode.");
  if (input.workspaceMode === "existing") {
    const path = str(input.worktreeCwd).trim();
    if (!path || path.length > 1_000)
      throw new Error("Choose an existing worktree for this automation.");
  }
  if (str(input.sessionFolderId).length > 80) throw new Error("Invalid automation session folder.");
  if (!["supervised", "auto-accept-edits", "auto", "full-access"].includes(input.runtimeMode))
    throw new Error("Invalid automation run mode.");
  if (!KINDS.includes(input.triggerKind ?? "time")) throw new Error("Invalid automation trigger.");
  if (str(input.triggerEvent).length > 200) throw new Error("Invalid automation trigger event.");
  if (!SCHEDULES.includes(input.scheduleKind)) throw new Error("Invalid automation schedule.");
  if (!int(input.minute, 0, 59) || !int(input.dayOfWeek, 0, 6) || !validTime(input.time))
    throw new Error("Invalid automation time.");
  if (!int(input.missedRunGraceMinutes, 0, 43_200))
    throw new Error("Invalid missed-run grace period.");
  if (!Number.isFinite(input.nextRunAt) || (!imported && input.nextRunAt <= now))
    throw new Error("The next automation run must be in the future.");
  if (input.triggers != null) {
    if (!Array.isArray(input.triggers) || input.triggers.length > MAX_TRIGGERS)
      throw new Error("Too many automation triggers.");
    for (const trigger of input.triggers) validateTrigger(trigger ?? {});
  }
}

function legacyTrigger(source: Json): Json {
  return {
    id: `${source.id}:legacy`,
    kind: source.triggerKind ?? "time",
    event: str(source.triggerEvent) || source.scheduleKind,
    scheduleKind: source.scheduleKind,
    minute: source.minute,
    time: source.time,
    dayOfWeek: source.dayOfWeek,
    repos: [],
    repo: "",
    branch: "",
    actor: "anyone",
  };
}

function normalizeTriggers(input: Json): Json[] {
  const triggers: Json[] = Array.isArray(input.triggers) ? input.triggers : [legacyTrigger(input)];
  return triggers.map((trigger) => ({
    ...trigger,
    id: str(trigger.id).trim() || randomUUID(),
    event: str(trigger.event).trim(),
    scheduleKind: trigger.scheduleKind ?? "weekdays",
    minute: trigger.minute ?? 0,
    time: trigger.time ?? "09:00",
    dayOfWeek: trigger.dayOfWeek ?? 1,
    repo: str(trigger.repo).trim(),
    branch: str(trigger.branch).trim(),
    actor: str(trigger.actor).trim() || "anyone",
    repos: (Array.isArray(trigger.repos) ? trigger.repos : [])
      .map((repo: unknown) => str(repo).trim())
      .filter(Boolean),
  }));
}

function triggersOf(automation: Json): Json[] {
  return Array.isArray(automation.triggers) ? automation.triggers : [legacyTrigger(automation)];
}

function pick(source: Json | undefined, keys: string[]): Json {
  return Object.fromEntries(keys.flatMap((key) => (source?.[key] != null ? [[key, source[key]]] : [])));
}

function summarize(automation: HostAutomation, run: HostAutomationRun): void {
  if (automation.lastRunAt == null || run.createdAt >= automation.lastRunAt) {
    automation.lastRunAt = run.createdAt;
    automation.lastRunStatus = run.status;
    if (run.error) automation.lastRunError = run.error;
    else delete automation.lastRunError;
    if (run.sessionId) automation.lastSessionId = run.sessionId;
  }
}

export class HostAutomations {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, definition_json TEXT NOT NULL,
        enabled INTEGER NOT NULL, next_run_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_runs (id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL, run_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS automation_runs_history_idx
        ON automation_runs (automation_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS automation_event_claims (
        automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
        event_key TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (automation_id, event_key));`);
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private get(automationId: string): HostAutomation | undefined {
    const row = this.db.prepare("SELECT definition_json FROM automations WHERE id = ?").get(automationId);
    if (!row) return undefined;
    const automation = JSON.parse(String(row.definition_json)) as HostAutomation;
    automation.triggers = triggersOf(automation);
    return automation;
  }

  private require(automationId: string): HostAutomation {
    const automation = this.get(automationId);
    if (!automation) throw new Error("Automation not found.");
    return automation;
  }

  private write(automation: HostAutomation): void {
    this.db
      .prepare(`INSERT INTO automations (id, definition_json, enabled, next_run_at, updated_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
        definition_json = excluded.definition_json, enabled = excluded.enabled,
        next_run_at = excluded.next_run_at, updated_at = excluded.updated_at`)
      .run(automation.id, JSON.stringify(automation), automation.enabled ? 1 : 0,
        automation.nextRunAt, automation.updatedAt ?? Date.now());
  }

  private writeRun(run: HostAutomationRun): void {
    this.db
      .prepare(`INSERT INTO automation_runs (id, automation_id, created_at, run_json) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET run_json = excluded.run_json`)
      .run(run.id, run.automationId, run.createdAt, JSON.stringify(run));
  }

  private trim(automationId: string): void {
    const rows = this.db
      .prepare("SELECT id, run_json FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC, id DESC")
      .all(automationId);
    const remove = this.db.prepare("DELETE FROM automation_runs WHERE id = ?");
    rows.slice(MAX_RUNS_PER_AUTOMATION).forEach((row) => {
      if (DONE.includes(JSON.parse(String(row.run_json)).status)) remove.run(String(row.id));
    });
  }

  private newRun(automation: HostAutomation, trigger: string, scheduledFor: number, now: number,
    prompt: string, device: string | undefined): HostAutomationRun {
    return {
      id: randomUUID(),
      automationId: automation.id,
      trigger,
      scheduledFor,
      createdAt: now,
      status: "pending",
      prompt,
      ...(device ? { claimedBy: device } : {}),
    };
  }

  /** Records a run and its summary on the automation, in the open transaction. */
  private record(automation: HostAutomation, run: HostAutomationRun, now: number): void {
    automation.lastRunAt = now;
    automation.lastRunStatus = run.status;
    if (run.error) automation.lastRunError = run.error;
    else delete automation.lastRunError;
    this.writeRun(run);
    this.write(automation);
    this.trim(automation.id);
  }

  list(): HostAutomation[] {
    return this.db
      .prepare("SELECT id FROM automations ORDER BY updated_at DESC, id")
      .all()
      .map((row) => this.get(String(row.id))!);
  }

  upsert(input: unknown, now = Date.now(), imported = false): HostAutomation {
    if (!input || typeof input !== "object") throw new Error("Invalid automation");
    const draft = input as Json;
    validate(draft, now, imported);
    return this.transaction(() => {
      const previous = this.get(draft.id);
      if (imported && previous) return previous;
      // An import keeps the desktop's run summary; an edit keeps the host's.
      const source = imported ? draft : previous;
      const saved: HostAutomation = {
        id: draft.id,
        name: str(draft.name).trim(),
        prompt: draft.prompt,
        harness: draft.harness,
        model: draft.model,
        modelSettings: draft.modelSettings && typeof draft.modelSettings === "object" ? draft.modelSettings : {},
        cwd: draft.cwd,
        workspaceMode: draft.workspaceMode,
        worktreeCwd: draft.workspaceMode === "existing" ? str(draft.worktreeCwd).trim() : "",
        sessionFolderId: str(draft.sessionFolderId).trim(),
        reuseSession: draft.reuseSession === true,
        runtimeMode: draft.runtimeMode,
        triggerKind: draft.triggerKind ?? "time",
        triggerEvent: str(draft.triggerEvent).trim(),
        scheduleKind: draft.scheduleKind,
        minute: draft.minute,
        time: draft.time,
        dayOfWeek: draft.dayOfWeek,
        triggers: normalizeTriggers(draft),
        missedRunGraceMinutes: draft.missedRunGraceMinutes,
        enabled: draft.enabled !== false,
        nextRunAt: draft.nextRunAt,
        ...pick(source, ["lastRunAt", "lastRunStatus", "lastRunError", "lastSessionId"]),
        createdAt: imported && Number.isFinite(draft.createdAt) ? draft.createdAt : previous?.createdAt ?? now,
        updatedAt: now,
      };
      this.write(saved);
      return saved;
    });
  }

  delete(automationId: unknown): void {
    this.db.prepare("DELETE FROM automations WHERE id = ?").run(id(automationId, "automation"));
  }

  runs(automationId: unknown): HostAutomationRun[] {
    return this.db
      .prepare("SELECT run_json FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC LIMIT 100")
      .all(id(automationId, "automation"))
      .map((row) => {
        // Launch prompts are only needed by restart recovery.
        const { prompt: _, ...run } = JSON.parse(String(row.run_json)) as HostAutomationRun;
        return run as HostAutomationRun;
      });
  }

  /** This desktop's runs left over from before it restarted: a running one
   * was interrupted, a pending one is handed back to be launched. */
  recover(startedBefore: unknown, now: unknown, device: string | undefined): DueRun[] {
    const cutoff = Number(startedBefore);
    const at = Number(now);
    return this.transaction(() => {
      const due: DueRun[] = [];
      const rows = this.db
        .prepare("SELECT run_json FROM automation_runs WHERE created_at <= ? ORDER BY created_at, id")
        .all(cutoff);
      for (const row of rows) {
        const run = JSON.parse(String(row.run_json)) as HostAutomationRun;
        if (run.status !== "pending" && run.status !== "running") continue;
        if (run.claimedBy && run.claimedBy !== device) continue;
        const automation = this.get(run.automationId);
        if (!automation) continue;
        if (run.status === "running" || (run.trigger === "event" && !str(run.prompt).trim())) {
          run.error = run.status === "running"
            ? "Interrupted when sIDE last stopped."
            : "The Inbox event prompt was not available after restart.";
          run.status = run.status === "running" ? "cancelled" : "failed";
          run.completedAt = at;
          summarize(automation, run);
          this.writeRun(run);
          this.write(automation);
          this.trim(automation.id);
          continue;
        }
        due.push({ automation, run });
      }
      return due;
    });
  }

  runNow(automationId: unknown, now: unknown, device: string | undefined): HostAutomationRun {
    const at = Number(now);
    return this.transaction(() => {
      const automation = this.require(id(automationId, "automation"));
      const run = this.newRun(automation, "manual", at, at, automation.prompt, device);
      this.record(automation, run, at);
      return run;
    });
  }

  /** Claims the occurrence due at `expectedNextRunAt` by moving the schedule
   * to `nextRunAt`; a desktop that lost the race gets `null`. */
  claimDue(input: Json, device: string | undefined): DueRun | null {
    const automationId = id(input.automationId, "automation");
    const expected = Number(input.expectedNextRunAt);
    const next = Number(input.nextRunAt);
    const now = Number(input.now);
    if (!(next > expected)) throw new Error("The following automation occurrence must advance the schedule.");
    return this.transaction(() => {
      const current = this.require(automationId);
      if (!triggersOf(current).some((trigger) => trigger.kind === "time")) return null;
      const claimed = this.db
        .prepare("UPDATE automations SET next_run_at = ? WHERE id = ? AND enabled = 1 AND next_run_at = ? AND next_run_at <= ?")
        .run(next, automationId, expected, now);
      if (!Number(claimed.changes)) return null;
      const automation: HostAutomation = { ...current, nextRunAt: next };
      const run = this.newRun(automation, "scheduled", expected, now, automation.prompt, device);
      if (now - expected > automation.missedRunGraceMinutes * 60_000) {
        run.status = "skipped";
        run.completedAt = now;
        run.error = "Missed the scheduled run beyond its grace period.";
      }
      this.record(automation, run, now);
      return { automation, run };
    });
  }

  /** Claims one Inbox event for one automation, once across every desktop. */
  claimEvent(input: Json, device: string | undefined): DueRun | null {
    const automationId = id(input.automationId, "automation");
    const claim = (input.claim ?? {}) as Json;
    const now = Number(input.now);
    const key = str(claim.eventKey);
    if (!key || key.length > 400 || !/^[A-Za-z0-9_:/.-]+$/.test(key))
      throw new Error("Invalid automation event key.");
    if (!EVENT_KINDS.includes(claim.eventKind)) throw new Error("Invalid automation trigger.");
    if (!str(claim.event) || str(claim.event).length > 200)
      throw new Error("Invalid automation trigger event.");
    if (!str(claim.prompt).trim() || str(claim.prompt).length > MAX_PROMPT + 10_000)
      throw new Error("Invalid automation run prompt.");
    return this.transaction(() => {
      const automation = this.require(automationId);
      if (
        !automation.enabled ||
        !triggersOf(automation).some((trigger) => trigger.kind === claim.eventKind && trigger.event === claim.event)
      )
        return null;
      const inserted = this.db
        .prepare("INSERT OR IGNORE INTO automation_event_claims (automation_id, event_key, created_at) VALUES (?, ?, ?)")
        .run(automationId, key, now);
      if (!Number(inserted.changes)) return null;
      const run = this.newRun(automation, "event",
        Number(claim.scheduledFor) > 0 ? Number(claim.scheduledFor) : now, now, claim.prompt, device);
      Object.assign(run, { eventKey: key, eventKind: claim.eventKind, event: claim.event });
      this.record(automation, run, now);
      return { automation, run };
    });
  }

  updateRun(input: Json): HostAutomationRun {
    const runId = id(input.runId, "automation run");
    if (input.sessionId != null) id(input.sessionId, "session");
    if (!RUN_STATUSES.includes(input.status)) throw new Error("Invalid automation run status.");
    const now = Number(input.now);
    return this.transaction(() => {
      const row = this.db.prepare("SELECT run_json FROM automation_runs WHERE id = ?").get(runId);
      if (!row) throw new Error("Automation run not found.");
      const run = JSON.parse(String(row.run_json)) as HostAutomationRun;
      run.status = input.status;
      if (run.status === "running" && run.startedAt == null) run.startedAt = now;
      if (DONE.includes(run.status)) run.completedAt = now;
      if (input.sessionId != null) run.sessionId = input.sessionId;
      const error = str(input.error).trim() ? input.error : undefined;
      if (error) run.error = error;
      else delete run.error;
      const automation = this.require(run.automationId);
      summarize(automation, run);
      this.writeRun(run);
      this.write(automation);
      this.trim(automation.id);
      return run;
    });
  }
}
