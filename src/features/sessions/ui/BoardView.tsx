import { useEffect, useState, type ReactNode } from "react";
import { OverlayNav } from "../../../app/shell/TitleBar";
import { WindowControls } from "../../../app/shell/WindowControls";
import { IS_MAC } from "../../../platform/tauri/platform";
import { DashboardSquare } from "../../../shared/ui/icons";
import {
  loadTabGroupColors,
  loadTabGroupCustomColors,
  loadTabGroupLabels,
  loadTabGroupMascots,
} from "../../workspace/model/tabGroups";
import type { SessionBoard } from "../hooks/useSessionBoard";
import { LiveAgentCard } from "./LiveAgentsPreview";
import { CheckedSessionRow } from "./ReviewAgentsSection";

type Props = {
  board: SessionBoard;
  activeSessionId?: string;
  besideRail?: boolean;
  compactRail?: boolean;
  onClose: () => void;
  onToggleSidebar?: () => void;
};

/**
 * Every session on one board, yours and your colleagues': what waits on
 * you, what works, and what you checked, as the rail lists them.
 */
export function BoardView({
  board,
  activeSessionId,
  besideRail = false,
  compactRail = false,
  onClose,
  onToggleSidebar,
}: Props) {
  const [groupLabels] = useState(loadTabGroupLabels);
  const [groupColors] = useState(loadTabGroupColors);
  const [groupCustomColors] = useState(loadTabGroupCustomColors);
  const [groupMascots] = useState(loadTabGroupMascots);
  const groups = { groupLabels, groupColors, groupCustomColors, groupMascots };
  const [now, setNow] = useState(() => Date.now());
  const ticking = board.working.some((agent) => agent.startedAt != null);
  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ticking]);

  return (
    <div
      role="region"
      aria-label="Board"
      data-app-board
      className="flex min-h-0 min-w-0 flex-1 flex-col text-content"
    >
      <div
        className="flex h-10 shrink-0 select-none items-center border-b border-stroke"
        data-tauri-drag-region="deep"
      >
        {IS_MAC && compactRail ? <div className="w-4 shrink-0" /> : null}
        {IS_MAC && !besideRail ? <div className="w-[78px] shrink-0" /> : null}
        {besideRail ? null : (
          <OverlayNav onBack={onClose} onToggleSidebar={onToggleSidebar} />
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
          <DashboardSquare
            className="size-3.5 shrink-0 text-content/45"
            strokeWidth={1.75}
          />
          <span className="min-w-0 truncate text-content">Board</span>
        </div>
        {IS_MAC ? null : <WindowControls />}
      </div>
      {board.enabled ? (
        <div className="grid min-h-0 flex-1 grid-cols-3 gap-3 overflow-x-auto p-3 max-md:grid-cols-[repeat(3,minmax(240px,1fr))]">
          <Column label="To review" count={board.review.length}>
            {board.review.map((agent) => (
              <LiveAgentCard
                key={agent.id}
                agent={agent}
                now={now}
                selected={agent.id === activeSessionId}
                onSelect={board.onSelect}
                onMarkChecked={board.onMarkChecked}
                {...groups}
              />
            ))}
          </Column>
          <Column label="Working" count={board.working.length}>
            {board.working.map((agent) => (
              <LiveAgentCard
                key={agent.id}
                agent={agent}
                now={now}
                selected={agent.id === activeSessionId}
                onSelect={board.onSelect}
                {...groups}
              />
            ))}
          </Column>
          <Column label="Checked" count={board.checked.length}>
            {board.checked.map((entry) => (
              <CheckedSessionRow
                key={entry.id}
                entry={entry}
                selected={entry.id === activeSessionId}
                onSelect={board.onSelect}
                {...groups}
              />
            ))}
          </Column>
        </div>
      ) : (
        <p className="px-4 py-6 text-[13px] text-content/50">
          The board is off. Turn on Working agents in Settings to see every
          session here.
        </p>
      )}
    </div>
  );
}

function Column({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      data-board-column={label}
      className="flex min-h-0 min-w-0 flex-col rounded-lg bg-content/5"
    >
      <div className="flex shrink-0 items-center gap-1 px-3 pb-1 pt-2">
        <span className="min-w-0 flex-1 truncate text-xs leading-5 text-content/50">
          {label}
        </span>
        <span className="text-[11px] tabular-nums text-content/40">
          {count}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-1 pb-1">
        {count ? (
          children
        ) : (
          <p className="px-2 py-3 text-[12px] text-content/40">Nothing here</p>
        )}
      </div>
    </section>
  );
}
