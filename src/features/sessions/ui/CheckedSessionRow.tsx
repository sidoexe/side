import type { ReactNode } from "react";
import type { CheckedSession } from "../model/sessionChecked";
import { projectKey, projectName } from "../../../shared/lib/paths";
import {
  resolveTabGroupColor,
  resolveTabGroupLabel,
  resolveTabGroupMascot,
} from "../../workspace/model/tabGroups";
import { Archive, Check, Trash2 } from "../../../shared/ui/icons";
import { ProjectMascot } from "../../projects/ui/ProjectMascot";

/** A session the user checked, dimmed, opening it again on a click. */
export function CheckedSessionRow({
  entry,
  selected,
  onSelect,
  onArchive,
  onDelete,
  groupLabels,
  groupColors,
  groupCustomColors,
  groupMascots,
}: {
  entry: CheckedSession;
  selected: boolean;
  onSelect?: (sessionId: string) => void;
  onArchive?: (sessionId: string) => void;
  onDelete?: (sessionId: string) => void;
  groupLabels: Record<string, string>;
  groupColors: Record<string, number>;
  groupCustomColors: Record<string, string>;
  groupMascots: Record<string, string>;
}) {
  const seed = projectName(entry.cwd);
  const key = projectKey(entry.cwd);
  const project = resolveTabGroupLabel(key, groupLabels, seed);
  const row = (
    <button
      type="button"
      title={[entry.title, project].join("\n")}
      aria-label={`${entry.title}, ${project}, checked`}
      aria-current={selected ? "true" : undefined}
      data-checked-session={entry.id}
      onClick={() => onSelect?.(entry.id)}
      className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left ${
        selected ? "bg-selection" : "hover:bg-content/8"
      }`}
    >
      <ProjectMascot
        project={seed}
        color={resolveTabGroupColor(key, groupColors, groupCustomColors, seed)}
        name={resolveTabGroupMascot(key, groupMascots)}
        className="size-2 shrink-0"
      />
      <span className="min-w-0 flex-1 truncate text-[13px] text-content/60">
        {entry.title}
      </span>
      <Check
        className={`size-3 shrink-0 text-content/35 ${
          onArchive || onDelete ? "group-hover/checked:invisible" : ""
        }`}
        strokeWidth={2.25}
      />
    </button>
  );
  if (!onArchive && !onDelete) return row;
  return (
    <div className="group/checked relative">
      {row}
      <div className="absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-0 focus-within:opacity-100 group-hover/checked:opacity-100">
        {onArchive ? (
          <RowAction
            label={`Archive ${entry.title}`}
            title="Archive"
            onClick={() => onArchive(entry.id)}
          >
            <Archive className="size-3" strokeWidth={2} />
          </RowAction>
        ) : null}
        {onDelete ? (
          <RowAction
            label={`Delete ${entry.title}`}
            title="Delete"
            onClick={() => onDelete(entry.id)}
          >
            <Trash2 className="size-3" strokeWidth={2} />
          </RowAction>
        ) : null}
      </div>
    </div>
  );
}

function RowAction({
  label,
  title,
  onClick,
  children,
}: {
  label: string;
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={label}
      data-no-drag
      onClick={onClick}
      className="flex size-5 items-center justify-center rounded bg-background-base text-content/50 hover:text-content"
    >
      {children}
    </button>
  );
}
