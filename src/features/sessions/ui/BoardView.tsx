import {
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { OverlayNav } from "../../../app/shell/TitleBar";
import { WindowControls } from "../../../app/shell/WindowControls";
import { IS_MAC } from "../../../platform/tauri/platform";
import {
  Archive,
  DashboardSquare,
  ImagePlus,
  Maximize2,
  Trash2,
  X,
} from "../../../shared/ui/icons";
import {
  loadProjectChatBackgroundSettings,
  projectChatBackgroundImageRevision,
  projectChatBackgroundRevision,
  subscribeProjectChatBackground,
} from "../../projects/model/projectChatBackground";
import { ProjectBackgroundDialog } from "../../projects/ui/ProjectBackgroundDialog";
import { useProjectBackgroundEffect } from "../../projects/ui/useProjectBackgroundEffect";
import { GradientBlurBackground } from "../../settings/ui/GradientBlurBackground";
import {
  loadTabGroupColors,
  loadTabGroupCustomColors,
  loadTabGroupLabels,
  loadTabGroupMascots,
} from "../../workspace/model/tabGroups";
import { useAnimatedReorder } from "../../../shared/hooks/useAnimatedReorder";
import type { SessionBoard } from "../hooks/useSessionBoard";
import type { BoardColumn } from "../model/boardOrder";
import { CheckedSessionRow } from "./CheckedSessionRow";
import { LiveAgentCard } from "./LiveAgentCard";

/** Stores the board's own background beside the projects' ones. */
const BOARD_BACKGROUND_KEY = "side:board";

type Props = {
  board: SessionBoard;
  activeSessionId?: string;
  besideRail?: boolean;
  compactRail?: boolean;
  /** A session from the board is open beside it: the board narrows to one
   * stacked column on its left. */
  peek?: boolean;
  onClose: () => void;
  /** Widens the board back over the session. */
  onExpand?: () => void;
  onToggleSidebar?: () => void;
  /** Archives checked sessions, one from its row or the whole column. */
  onArchiveSessions?: (sessionIds: readonly string[]) => void;
  /** Deletes one checked session from its row. */
  onDeleteSession?: (sessionId: string) => void;
  /** Deletes the whole Checked column, after asking. */
  onDeleteSessions?: (sessionIds: readonly string[]) => void;
};

/**
 * Every session on one board: what works, what waits on you, and what
 * you checked, left to right as work moves.
 */
export function BoardView({
  board,
  activeSessionId,
  besideRail = false,
  compactRail = false,
  peek = false,
  onClose,
  onExpand,
  onToggleSidebar,
  onArchiveSessions,
  onDeleteSession,
  onDeleteSessions,
}: Props) {
  const checkedIds = board.checked.map(({ id }) => id);
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
  const [choosingBackground, setChoosingBackground] = useState(false);
  useSyncExternalStore(
    subscribeProjectChatBackground,
    projectChatBackgroundRevision,
    projectChatBackgroundRevision,
  );
  const background = loadProjectChatBackgroundSettings(BOARD_BACKGROUND_KEY);
  const backgroundUrl = useProjectBackgroundEffect(
    background?.path ?? null,
    background?.effect ?? "none",
    projectChatBackgroundImageRevision(),
  );
  const backgroundStyle = background
    ? ({
        "--chat-background-image": backgroundUrl
          ? `url(${JSON.stringify(backgroundUrl)})`
          : "none",
        "--chat-background-empty-opacity": String(background.emptyOpacity),
      } as CSSProperties)
    : undefined;

  return (
    <div
      role="region"
      aria-label="Board"
      data-app-board
      data-board-peek={peek ? "" : undefined}
      // Only its own image: the board never falls back to the global one.
      data-session-empty={background ? true : undefined}
      data-project-chat-background={background ? true : undefined}
      data-project-background-effect={background?.effect}
      style={backgroundStyle}
      className={`relative isolate flex min-h-0 flex-col text-content ${
        background ? "chat-pane-background" : ""
      } ${
        peek
          ? "order-first w-[320px] shrink-0 border-r border-stroke"
          : "min-w-0 flex-1"
      }`}
    >
      {background?.effect === "gradient-blur" ? (
        <GradientBlurBackground />
      ) : null}
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
          <span className="min-w-0 flex-1 truncate text-content">Board</span>
          <BoardHeaderButton
            label="Background image"
            onClick={() => setChoosingBackground(true)}
          >
            <ImagePlus className="size-3.5" strokeWidth={1.75} />
          </BoardHeaderButton>
          {peek ? (
            <>
              <BoardHeaderButton label="Expand board" onClick={onExpand}>
                <Maximize2 className="size-3.5" strokeWidth={1.75} />
              </BoardHeaderButton>
              <BoardHeaderButton label="Close board" onClick={onClose}>
                <X className="size-3.5" strokeWidth={1.75} />
              </BoardHeaderButton>
            </>
          ) : null}
        </div>
        {IS_MAC || peek ? null : <WindowControls />}
      </div>
      {board.enabled ? (
        <div
          className={
            peek
              ? "flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2"
              : "grid min-h-0 flex-1 grid-cols-3 gap-3 overflow-x-auto p-3 max-md:grid-cols-[repeat(3,minmax(240px,1fr))]"
          }
        >
          <Column label="Working" count={board.working.length} stacked={peek}>
            <SortableCards
              column="working"
              items={board.working}
              onReorder={board.onReorder}
            >
              {(agent) => (
                <LiveAgentCard
                  agent={agent}
                  now={now}
                  selected={agent.id === activeSessionId}
                  onSelect={board.onSelect}
                  {...groups}
                />
              )}
            </SortableCards>
          </Column>
          <Column label="To review" count={board.review.length} stacked={peek}>
            <SortableCards
              column="review"
              items={board.review}
              onReorder={board.onReorder}
            >
              {(agent) => (
                <LiveAgentCard
                  agent={agent}
                  now={now}
                  selected={agent.id === activeSessionId}
                  onSelect={board.onSelect}
                  onMarkChecked={board.onMarkChecked}
                  {...groups}
                />
              )}
            </SortableCards>
          </Column>
          <Column
            label="Checked"
            count={board.checked.length}
            stacked={peek}
            actions={
              board.checked.length ? (
                <>
                  {onArchiveSessions ? (
                    <ColumnAction
                      label="Archive all checked"
                      onClick={() => onArchiveSessions(checkedIds)}
                    >
                      <Archive className="size-3" strokeWidth={2} />
                    </ColumnAction>
                  ) : null}
                  {onDeleteSessions ? (
                    <ColumnAction
                      label="Delete all checked"
                      onClick={() => onDeleteSessions(checkedIds)}
                    >
                      <Trash2 className="size-3" strokeWidth={2} />
                    </ColumnAction>
                  ) : null}
                </>
              ) : null
            }
          >
            <SortableCards
              column="checked"
              items={board.checked}
              onReorder={board.onReorder}
            >
              {(entry) => (
                <CheckedSessionRow
                  entry={entry}
                  selected={entry.id === activeSessionId}
                  onSelect={board.onSelect}
                  onArchive={
                    onArchiveSessions && ((id) => onArchiveSessions([id]))
                  }
                  onDelete={onDeleteSession}
                  {...groups}
                />
              )}
            </SortableCards>
          </Column>
        </div>
      ) : (
        <p className="px-4 py-6 text-[13px] text-content/50">
          The board is off. Turn on Working agents in Settings to see every
          session here.
        </p>
      )}
      {choosingBackground ? (
        <ProjectBackgroundDialog
          project={BOARD_BACKGROUND_KEY}
          name="the Board"
          standalone
          onClose={() => setChoosingBackground(false)}
        />
      ) : null}
    </div>
  );
}

function BoardHeaderButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-content/50 hover:bg-content/8 hover:text-content"
    >
      {children}
    </button>
  );
}

/** A column's cards, reordered by dragging within it. */
function SortableCards<T extends { id: string }>({
  column,
  items,
  onReorder,
  children,
}: {
  column: BoardColumn;
  items: T[];
  onReorder: SessionBoard["onReorder"];
  children: (item: T) => ReactNode;
}) {
  const sortable = useAnimatedReorder(
    items.map(({ id }) => id),
    (ids) => onReorder(column, ids),
    "y",
  );
  return items.map((item) => (
    <div
      key={item.id}
      ref={(node) => sortable.setItemRef(item.id, node)}
      data-board-card={item.id}
      className="reorder-item touch-none"
      onPointerDown={(event) => {
        // The card's own buttons, such as Mark checked, stay clicks.
        if ((event.target as HTMLElement).closest("[data-no-drag]")) return;
        sortable.onItemPointerDown(item.id, event);
      }}
      onClickCapture={(event) => {
        if (sortable.consumeClick()) event.stopPropagation();
      }}
    >
      {children(item)}
    </div>
  ));
}

function ColumnAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex size-5 shrink-0 items-center justify-center rounded text-content/40 hover:bg-content/8 hover:text-content"
    >
      {children}
    </button>
  );
}

function Column({
  label,
  count,
  stacked = false,
  actions,
  children,
}: {
  label: string;
  count: number;
  /** Buttons acting on the whole column, beside its count. */
  actions?: ReactNode;
  /** Sized to its cards, one under another, rather than filling a column. */
  stacked?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      data-board-column={label}
      className={`flex min-w-0 flex-col rounded-lg bg-content/5 ${
        stacked ? "shrink-0" : "min-h-0"
      }`}
    >
      <div className="flex shrink-0 items-center gap-1 px-3 pb-1 pt-2">
        <span className="min-w-0 flex-1 truncate text-xs leading-5 text-content/50">
          {label}
        </span>
        {actions}
        <span className="text-[11px] tabular-nums text-content/40">
          {count}
        </span>
      </div>
      <div
        className={`flex flex-col gap-px px-1 pb-1 ${
          stacked ? "" : "min-h-0 flex-1 overflow-y-auto"
        }`}
      >
        {count ? (
          children
        ) : (
          <p className="px-2 py-3 text-[12px] text-content/40">Nothing here</p>
        )}
      </div>
    </section>
  );
}
