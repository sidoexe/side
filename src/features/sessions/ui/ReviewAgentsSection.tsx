import { useState } from "react";
import type { LiveAgent } from "../model/liveAgents";
import type { CheckedSession } from "../model/sessionChecked";
import { projectKey, projectName } from "../../../shared/lib/paths";
import {
  resolveTabGroupColor,
  resolveTabGroupLabel,
  resolveTabGroupMascot,
} from "../../workspace/model/tabGroups";
import { Check, ChevronDown, ChevronUp } from "../../../shared/ui/icons";
import { ProjectMascot } from "../../projects/ui/ProjectMascot";
import { LiveAgentCard } from "./LiveAgentsPreview";

type Props = {
  /** Agents that need input or finished, across every project. */
  agents: LiveAgent[];
  /** Sessions the user checked, last checked first. */
  checked?: CheckedSession[];
  activeSessionId?: string;
  onSelect?: (sessionId: string) => void;
  onMarkChecked?: (agent: LiveAgent) => void;
  groupLabels: Record<string, string>;
  groupColors: Record<string, number>;
  groupCustomColors: Record<string, string>;
  groupMascots: Record<string, string>;
};

/** The rail section under the projects listing what waits on the user,
 * then what they checked. */
export function ReviewAgentsSection({
  agents,
  checked = [],
  activeSessionId,
  onSelect,
  onMarkChecked,
  groupLabels,
  groupColors,
  groupCustomColors,
  groupMascots,
}: Props) {
  const [checkedOpen, setCheckedOpen] = useState(false);
  if (agents.length === 0 && checked.length === 0) return null;
  const now = Date.now();
  return (
    <section aria-label="To review" className="mb-2 shrink-0">
      {agents.length > 0 ? (
        <>
          <div className="flex items-center gap-1 px-3 pb-1.5 pt-1">
            <span className="min-w-0 flex-1 truncate px-1 text-xs leading-5 text-content/50">
              To review
            </span>
            <span className="px-1 text-[11px] tabular-nums text-content/40">
              {agents.length}
            </span>
          </div>
          <div className="flex flex-col gap-px px-2">
            {agents.map((agent) => (
              <LiveAgentCard
                key={agent.id}
                agent={agent}
                now={now}
                selected={agent.id === activeSessionId}
                onSelect={onSelect}
                onMarkChecked={onMarkChecked}
                groupLabels={groupLabels}
                groupColors={groupColors}
                groupCustomColors={groupCustomColors}
                groupMascots={groupMascots}
              />
            ))}
          </div>
        </>
      ) : null}
      {checked.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={checkedOpen}
            onClick={() => setCheckedOpen((open) => !open)}
            className="mx-2 mt-1 flex w-[calc(100%-1rem)] items-center gap-1 rounded-md px-2 py-1 text-left hover:bg-content/8"
          >
            <span className="min-w-0 flex-1 truncate text-xs leading-5 text-content/50">
              Checked
            </span>
            <span className="text-[11px] tabular-nums text-content/40">
              {checked.length}
            </span>
            {checkedOpen ? (
              <ChevronUp className="size-3 text-content/40" strokeWidth={1.75} />
            ) : (
              <ChevronDown className="size-3 text-content/40" strokeWidth={1.75} />
            )}
          </button>
          {checkedOpen ? (
            <div className="flex flex-col gap-px px-2">
              {checked.map((entry) => {
                const seed = projectName(entry.cwd);
                const key = projectKey(entry.cwd);
                const project = resolveTabGroupLabel(key, groupLabels, seed);
                return (
                  <button
                    key={entry.id}
                    type="button"
                    title={[entry.title, project].join("\n")}
                    aria-label={`${entry.title}, ${project}, checked`}
                    aria-current={
                      entry.id === activeSessionId ? "true" : undefined
                    }
                    data-checked-session={entry.id}
                    onClick={() => onSelect?.(entry.id)}
                    className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left ${
                      entry.id === activeSessionId
                        ? "bg-selection"
                        : "hover:bg-content/8"
                    }`}
                  >
                    <ProjectMascot
                      project={seed}
                      color={resolveTabGroupColor(
                        key,
                        groupColors,
                        groupCustomColors,
                        seed,
                      )}
                      name={resolveTabGroupMascot(key, groupMascots)}
                      className="size-2 shrink-0"
                    />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-content/60">
                      {entry.title}
                    </span>
                    <Check
                      className="size-3 shrink-0 text-content/35"
                      strokeWidth={2.25}
                    />
                  </button>
                );
              })}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
