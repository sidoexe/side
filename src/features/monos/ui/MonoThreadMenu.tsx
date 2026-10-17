import { useRef, useState } from "react";
import { formatResetDuration } from "../../providers/model/rateLimits";
import {
  Check,
  ChevronDown,
  Pencil,
  Plus,
  Trash2,
} from "../../../shared/ui/icons";
import { Popover, type PopoverDismissReason } from "../../../shared/ui/Popover";

export type MonoThreadItem = {
  id: string;
  title?: string;
  createdAt: number;
  busy: boolean;
};

export type MonoThreadMenuProps = {
  threads: MonoThreadItem[];
  current: string | undefined;
  onSelect: (threadId: string) => void;
  onNew: () => void;
  onRename: (threadId: string, title: string) => void;
  onDelete: (threadId: string) => void;
};

const UNTITLED = "New conversation";

const age = (at: number, now: number) =>
  !at ? "" : now - at < 60_000 ? "now" : formatResetDuration(now - at);

/**
 * The thread a Colleague's view shows, beside its name, and the others it
 * can switch to: each a conversation on its own topic.
 */
export function MonoThreadMenu({
  threads,
  current,
  onSelect,
  onNew,
  onRename,
  onDelete,
}: MonoThreadMenuProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState<string>();
  const [draft, setDraft] = useState("");
  const [deleting, setDeleting] = useState<string>();
  const shown = threads.find((thread) => thread.id === current);
  const now = Date.now();

  const close = (reason?: PopoverDismissReason) => {
    setOpen(false);
    setRenaming(undefined);
    setDeleting(undefined);
    if (reason === "escape")
      requestAnimationFrame(() => trigger.current?.focus());
  };
  const commitRename = (threadId: string) => {
    onRename(threadId, draft);
    setRenaming(undefined);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-mono-thread
        className="inline-flex h-6 min-w-0 max-w-64 items-center gap-1 rounded-md px-1.5 text-[12px] text-content/55 hover:bg-content/10 hover:text-content"
        aria-label={`Thread: ${shown?.title ?? UNTITLED}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="This Colleague's conversations"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="truncate">{shown?.title ?? UNTITLED}</span>
        {threads.length > 1 ? (
          <span className="shrink-0 tabular-nums text-content/35">
            {threads.length}
          </span>
        ) : null}
        <ChevronDown className="size-3 shrink-0" aria-hidden />
      </button>
      {open ? (
        <Popover
          anchor={trigger}
          side="bottom"
          align="start"
          gap={6}
          autoFocus
          onDismiss={close}
          role="menu"
          aria-label="Threads"
          className="w-[20rem] p-1"
        >
          <button
            type="button"
            role="menuitem"
            className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] text-content hover:bg-content/10"
            onClick={() => {
              close();
              onNew();
            }}
          >
            <Plus className="size-3.5 shrink-0" aria-hidden />
            <span className="flex-1">New thread</span>
            <span className="text-[11px] text-content/35">
              Same soul and memory
            </span>
          </button>
          <div role="separator" className="my-1 h-px bg-content/10" />
          <div className="max-h-80 overflow-y-auto">
            {threads.map((thread) => {
              const selected = thread.id === current;
              if (renaming === thread.id)
                return (
                  <form
                    key={thread.id}
                    className="flex h-8 items-center gap-2 px-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      commitRename(thread.id);
                    }}
                  >
                    <input
                      autoFocus
                      aria-label="Thread name"
                      value={draft}
                      maxLength={120}
                      onChange={(event) => setDraft(event.target.value)}
                      onBlur={() => commitRename(thread.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.stopPropagation();
                          setRenaming(undefined);
                        }
                      }}
                      className="h-6 min-w-0 flex-1 rounded-md border border-content/15 bg-transparent px-1.5 text-[12px] text-content outline-none focus:border-accent"
                    />
                  </form>
                );
              return (
                <div key={thread.id} className="group relative">
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className="flex h-8 w-full items-center gap-2 rounded-lg px-2 pr-16 text-left text-[12px] text-content hover:bg-content/10"
                    onClick={() => {
                      close();
                      if (!selected) onSelect(thread.id);
                    }}
                  >
                    <span className="grid size-3 shrink-0 place-items-center">
                      {selected ? (
                        <Check className="size-3" strokeWidth={2} aria-hidden />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {thread.title ?? UNTITLED}
                    </span>
                    {thread.busy ? (
                      <span
                        className="size-1.5 shrink-0 rounded-full bg-sky-400"
                        aria-label="Working"
                        title="Working"
                      />
                    ) : null}
                    <span className="shrink-0 text-[11px] tabular-nums text-content/35 group-hover:hidden">
                      {age(thread.createdAt, now)}
                    </span>
                  </button>
                  <span className="absolute right-1 top-1 hidden items-center gap-0.5 group-hover:flex">
                    {deleting === thread.id ? (
                      <button
                        type="button"
                        className="h-6 rounded-md bg-red-500/15 px-2 text-[11px] text-red-600 hover:bg-red-500/25 dark:text-red-300"
                        onClick={() => {
                          setDeleting(undefined);
                          onDelete(thread.id);
                        }}
                      >
                        Delete
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          aria-label={`Rename ${thread.title ?? UNTITLED}`}
                          title="Rename"
                          className="grid size-6 place-items-center rounded-md text-content/40 hover:bg-content/10 hover:text-content"
                          onClick={() => {
                            setDraft(thread.title ?? "");
                            setRenaming(thread.id);
                          }}
                        >
                          <Pencil className="size-3" aria-hidden />
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete ${thread.title ?? UNTITLED}`}
                          title={
                            thread.busy
                              ? "Stops it and deletes the conversation"
                              : "Delete"
                          }
                          className="grid size-6 place-items-center rounded-md text-content/40 hover:bg-content/10 hover:text-red-500"
                          onClick={() => setDeleting(thread.id)}
                        >
                          <Trash2 className="size-3" aria-hidden />
                        </button>
                      </>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </Popover>
      ) : null}
    </>
  );
}
