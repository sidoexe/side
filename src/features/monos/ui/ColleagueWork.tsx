import { useEffect, useRef, useState } from "react";
import { projectName } from "../../../shared/lib/paths";
import { Popover } from "../../../shared/ui/Popover";
import { ChevronDown, ChevronUp, DashboardSquare } from "../../../shared/ui/icons";
import { sessionDisplayTitle } from "../../sessions/model/session";
import { HarnessIcon } from "../../sessions/ui/HarnessIcon";
import {
  activeWorkLine,
  colleagueWorkSummary,
  pinnedColleagueWork,
  sinceLastVisitLine,
  useColleagueWork,
  type ColleagueWorkItem,
} from "../model/colleagueWork";
import { listMonos, monoLook, type MonoLook } from "../model/mono";
import { ColleagueAvatar } from "./ColleagueAvatar";
import { LAUNCHED_STATUS } from "./LaunchedSessionCard";

/** Rows the strip shows before "more". */
const STRIP_ROWS = 4;

function ago(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** What a row says on its right: the call it waits for, its step, or when it ended. */
function rowNote(item: ColleagueWorkItem, now: number): string {
  if (item.state === "input") return item.activity ?? "Needs input";
  if (item.state === "working") return item.activity ?? "Working";
  const label = LAUNCHED_STATUS[item.state].label;
  return item.settledAt ? `${label} ${ago(item.settledAt, now)}` : label;
}

/** Re-renders each minute, so "5m ago" keeps up. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * One session a colleague started. One that needs input opens to be
 * answered there; its colleague's chat never asks in its place.
 */
export function ColleagueWorkRow({
  item,
  projects,
  now,
  open = false,
  onOpen,
}: {
  item: ColleagueWorkItem;
  projects?: MonoLook["projects"];
  now: number;
  open?: boolean;
  onOpen: () => void;
}) {
  const title = item.habit
    ? item.title
    : sessionDisplayTitle(item.title, item.harness);
  const project =
    projects?.find((entry) => entry.path === item.cwd)?.name ??
    projectName(item.cwd);
  const status = LAUNCHED_STATUS[item.state];
  const note = rowNote(item, now);
  return (
    <button
      type="button"
      data-colleague-work-item={item.sessionId}
      data-state={item.state}
      aria-pressed={open}
      aria-label={`Open session ${title}, ${note}`}
      onClick={onOpen}
      className={`flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left font-sans transition-colors hover:bg-content/6 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${open ? "bg-content/6" : ""}`}
    >
      {status.icon}
      <span className="min-w-0 flex-1 truncate text-[13px] text-content">
        {title}
      </span>
      <span
        className={`min-w-0 max-w-[40%] shrink truncate text-[12px] ${item.state === "input" ? "text-amber-400" : "text-content/50"}`}
        title={note}
      >
        {note}
      </span>
      <span
        className="flex min-w-0 max-w-[30%] shrink-0 items-center gap-1 rounded-full border border-content/10 bg-content/5 px-2 py-0.5 text-[11px] text-content/65 @max-md:hidden"
        title={item.cwd}
      >
        <HarnessIcon harness={item.harness} className="size-3 shrink-0" />
        <span className="min-w-0 truncate">{project}</span>
      </span>
    </button>
  );
}

/**
 * Pinned above a colleague's composer: what settled since the last visit,
 * and the sessions still running or waiting on the user, so they stay in
 * sight however far the chat scrolls.
 */
export function ColleagueWorkStrip({
  monoId,
  agent,
  openSessionId,
  onOpen,
  onShowAll,
}: {
  monoId: string;
  agent: MonoLook;
  openSessionId?: string;
  onOpen: (sessionId: string) => void;
  onShowAll: () => void;
}) {
  const store = useColleagueWork();
  const now = useMinute();
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const entry = store[monoId];
  if (!entry) return null;
  const rows = pinnedColleagueWork(entry.items, entry.seenAt);
  if (!rows.length) return null;
  const summary = colleagueWorkSummary(entry.items, entry.seenAt);
  const lines = [sinceLastVisitLine(summary), activeWorkLine(summary)].filter(
    Boolean,
  );
  const shown = expanded ? rows : rows.slice(0, STRIP_ROWS);
  return (
    <section
      data-colleague-work
      aria-label={`${agent.name}'s sessions`}
      className="mx-3 mb-2 rounded-xl border border-content/10 bg-background-base/80 px-1.5 py-1 backdrop-blur"
    >
      <div className="flex min-w-0 items-center gap-2 px-1.5 py-0.5">
        <span
          aria-hidden
          className={`size-1.5 shrink-0 rounded-full ${
            summary.input
              ? "bg-amber-400"
              : summary.working
                ? "animate-pulse bg-[var(--mono-color)] motion-reduce:animate-none"
                : "bg-content/30"
          }`}
        />
        <span className="min-w-0 flex-1 truncate text-[12px] text-content/60">
          {lines.join(" · ")}
        </span>
        <button
          type="button"
          onClick={onShowAll}
          className="shrink-0 rounded-md px-1.5 text-[12px] text-content/50 hover:bg-content/6 hover:text-content"
        >
          All sessions
        </button>
        <button
          type="button"
          aria-label={collapsed ? "Show sessions" : "Hide sessions"}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
          className="grid size-5 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/6 hover:text-content"
        >
          {collapsed ? (
            <ChevronUp className="size-3.5" strokeWidth={1.75} />
          ) : (
            <ChevronDown className="size-3.5" strokeWidth={1.75} />
          )}
        </button>
      </div>
      {collapsed ? null : (
        <div className="flex max-h-56 flex-col overflow-y-auto pb-0.5">
          {shown.map((item) => (
            <ColleagueWorkRow
              key={item.sessionId}
              item={item}
              projects={agent.projects}
              now={now}
              open={item.sessionId === openSessionId}
              onOpen={() => onOpen(item.sessionId)}
            />
          ))}
          {rows.length > shown.length ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="self-start rounded-md px-2 py-0.5 text-[12px] text-content/50 hover:bg-content/6 hover:text-content"
            >
              {rows.length - shown.length} more
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** How many sessions wait on the user across every colleague. */
export function useColleagueInputCount(): number {
  const store = useColleagueWork();
  return Object.values(store).reduce(
    (count, entry) =>
      count + entry.items.filter((item) => item.state === "input").length,
    0,
  );
}

/**
 * Every colleague's work on one board: the ones with a session waiting on
 * the user first, then the ones with work running or news to read.
 */
export function ColleagueBoard({
  onOpen,
}: {
  onOpen: (monoId: string, sessionId: string) => void;
}) {
  const store = useColleagueWork();
  const now = useMinute();
  const groups = listMonos()
    .map((mono) => {
      const entry = store[mono.id];
      const rows = entry ? pinnedColleagueWork(entry.items, entry.seenAt) : [];
      return {
        mono,
        look: monoLook(mono),
        rows,
        summary: colleagueWorkSummary(entry?.items ?? [], entry?.seenAt),
      };
    })
    .filter((group) => group.rows.length)
    .sort(
      (a, b) =>
        Number(!!b.summary.input) - Number(!!a.summary.input) ||
        b.summary.working - a.summary.working,
    );
  if (!groups.length)
    return (
      <p className="px-3 py-4 text-[13px] text-content/50">
        Nothing running. Sessions your colleagues start show here while they
        work, and once they end until you open that colleague.
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      {groups.map(({ mono, look, rows, summary }) => (
        <section key={mono.id} data-colleague-board={mono.id}>
          <div className="flex min-w-0 items-center gap-2 px-2 pb-0.5 pt-1">
            <ColleagueAvatar
              mascot={look.mascot}
              color={look.color}
              avatar={look.avatar}
              still
              className="size-4 shrink-0"
            />
            <span className="min-w-0 truncate text-[12px] font-medium text-content/80">
              {look.name}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-content/45">
              {[activeWorkLine(summary), sinceLastVisitLine(summary)]
                .filter(Boolean)
                .join(" · ")
                .replace("Since your last visit: ", "new: ")}
            </span>
          </div>
          {rows.map((item) => (
            <ColleagueWorkRow
              key={item.sessionId}
              item={item}
              projects={look.projects}
              now={now}
              onOpen={() => onOpen(mono.id, item.sessionId)}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

/** The rail's way to the board, marked while a session waits on the user. */
export function ColleagueBoardButton({
  onOpen,
}: {
  onOpen: (monoId: string, sessionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const waiting = useColleagueInputCount();
  const label = waiting
    ? `Colleagues' work, ${waiting} waiting on you`
    : "Colleagues' work";
  return (
    <>
      <button
        ref={anchor}
        type="button"
        title={label}
        aria-label={label}
        aria-expanded={open}
        data-colleague-board-button
        onClick={() => setOpen(!open)}
        className="relative grid size-5 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/8 hover:text-content"
      >
        <DashboardSquare className="size-3.5" strokeWidth={1.75} />
        {waiting ? (
          <span
            aria-hidden
            className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-amber-400"
          />
        ) : null}
      </button>
      {open ? (
        <Popover
          anchor={anchor}
          side="right"
          align="start"
          width={420}
          onDismiss={() => setOpen(false)}
          aria-label="Colleagues' work"
          className="p-1.5"
        >
          <ColleagueBoard
            onOpen={(monoId, sessionId) => {
              setOpen(false);
              onOpen(monoId, sessionId);
            }}
          />
        </Popover>
      ) : null}
    </>
  );
}
