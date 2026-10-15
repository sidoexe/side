import type { LiveAgent } from "../model/liveAgents";
import { LiveAgentCard } from "./LiveAgentsPreview";

type Props = {
  /** Agents that need input or finished, across every project. */
  agents: LiveAgent[];
  activeSessionId?: string;
  onSelect?: (sessionId: string) => void;
  groupLabels: Record<string, string>;
  groupColors: Record<string, number>;
  groupCustomColors: Record<string, string>;
  groupMascots: Record<string, string>;
};

/** The rail section under the projects listing what waits on the user. */
export function ReviewAgentsSection({
  agents,
  activeSessionId,
  onSelect,
  groupLabels,
  groupColors,
  groupCustomColors,
  groupMascots,
}: Props) {
  if (agents.length === 0) return null;
  const now = Date.now();
  return (
    <section aria-label="To review" className="mb-2 shrink-0">
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
            groupLabels={groupLabels}
            groupColors={groupColors}
            groupCustomColors={groupCustomColors}
            groupMascots={groupMascots}
          />
        ))}
      </div>
    </section>
  );
}
