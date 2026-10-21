import { formatLiveElapsed, type LiveAgent } from "../model/liveAgents";
import { projectKey, projectName } from "../../../shared/lib/paths";
import {
  resolveTabGroupColor,
  resolveTabGroupLabel,
  resolveTabGroupMascot,
} from "../../workspace/model/tabGroups";
import { Check, CircleAlert } from "../../../shared/ui/icons";
import { HarnessIcon } from "./HarnessIcon";
import { ProjectMascot } from "../../projects/ui/ProjectMascot";
import { TerminalSpinner } from "./TerminalSpinner";

export function LiveAgentCard({
  agent,
  now,
  selected,
  onSelect,
  groupLabels,
  groupColors,
  groupCustomColors,
  groupMascots,
  onMarkChecked,
}: {
  agent: LiveAgent;
  now: number;
  selected: boolean;
  onSelect?: (sessionId: string) => void;
  /** Offered on done rows, as on a project's session list. */
  onMarkChecked?: (agent: LiveAgent) => void;
  groupLabels: Record<string, string>;
  groupColors: Record<string, number>;
  groupCustomColors: Record<string, string>;
  groupMascots: Record<string, string>;
}) {
  const seed = projectName(agent.cwd);
  const key = projectKey(agent.cwd);
  const project = resolveTabGroupLabel(key, groupLabels, seed);
  const color = resolveTabGroupColor(key, groupColors, groupCustomColors, seed);
  const elapsed = agent.done
    ? agent.durationMs != null
      ? formatLiveElapsed(0, agent.durationMs)
      : ""
    : agent.startedAt != null
      ? formatLiveElapsed(agent.startedAt, now)
      : "";
  const activity = agent.needsApproval
    ? "Need approval"
    : agent.failed
      ? "Failed"
      : agent.done
        ? "Done"
        : agent.activity;
  const live = !agent.needsApproval && !agent.done;
  const title = [agent.title, project, activity, elapsed]
    .filter(Boolean)
    .join("\n");

  const checkable = agent.done && !agent.needsApproval && onMarkChecked;

  const card = (
    <button
      type="button"
      title={title}
      aria-label={[agent.title, project, activity, elapsed]
        .filter(Boolean)
        .join(", ")}
      aria-current={selected ? "true" : undefined}
      data-live-agent-card={agent.id}
      onClick={() => onSelect?.(agent.id)}
      className={`relative flex w-full flex-col rounded-md px-2 py-1.5 text-left ${
        selected ? "bg-selection" : "hover:bg-content/8"
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <ProjectMascot
          project={seed}
          color={color}
          name={resolveTabGroupMascot(key, groupMascots)}
          className="size-2 shrink-0"
          active={live}
        />
        {live ? (
          <p className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-snug">
            {agent.title}
          </p>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-snug">
            {agent.title}
          </span>
        )}
      </span>
      <span
        className={`mt-1 flex min-w-0 items-center gap-1.5 pl-4 text-[11px] leading-tight ${
          agent.needsApproval
            ? "text-amber-400"
            : agent.failed
              ? "text-red-400"
              : agent.done
              ? "text-emerald-400"
              : "text-content/50"
        }`}
      >
        {agent.needsApproval || agent.failed ? (
          <CircleAlert className="size-3 shrink-0" strokeWidth={1.75} />
        ) : agent.done ? (
          <Check className="size-3 shrink-0" strokeWidth={2.25} />
        ) : (
          <TerminalSpinner className="inline-block w-3 select-none text-center text-[11px] leading-none" />
        )}
        <span className="min-w-0 truncate">{activity}</span>
      </span>
      <span className="mt-1 flex min-w-0 items-center gap-1.5 pl-4 text-[11px] leading-tight text-content/45">
        <HarnessIcon harness={agent.harness} className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{project}</span>
        {elapsed ? (
          <span className="shrink-0 tabular-nums">{elapsed}</span>
        ) : null}
      </span>
    </button>
  );
  if (!checkable) return card;
  return (
    <div className="group/review relative">
      {card}
      <button
        type="button"
        title="Mark checked"
        aria-label={`Mark ${agent.title} checked`}
        data-live-agent-check={agent.id}
        data-no-drag
        onClick={() => onMarkChecked(agent)}
        className="absolute right-1.5 top-[23px] flex h-[18px] items-center gap-1 rounded bg-background-base px-1.5 text-[11px] text-content/60 opacity-0 hover:text-content focus-visible:opacity-100 group-hover/review:opacity-100"
      >
        <Check className="size-3" strokeWidth={2.25} />
        Checked
      </button>
    </div>
  );
}
