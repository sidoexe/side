import { useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  Pencil,
  Plus,
  X,
} from "../../shared/ui/icons";
import { useAnimatedReorder } from "../../shared/hooks/useAnimatedReorder";
import { useWebApps } from "../../features/web-apps/hooks/useWebApps";
import {
  addWebApp,
  deleteWebApp,
  moveWebAppToFolder,
  normalizeWebAppFolder,
  renameWebApp,
  renameWebAppFolder,
  reorderWebApps,
  saveActiveWebApp,
  setWebAppFolderCollapsed,
  ungroupWebAppFolder,
  webAppFolders,
  type WebApp,
} from "../../features/web-apps/model/webApps";

/** The folder picker's choice that asks for a new folder's name. */
const NEW_FOLDER = "\u0000new";

const inputClass =
  "h-8 rounded-md bg-content/8 px-2 text-sm text-content outline-none placeholder:text-content/40";

/**
 * The web apps, listed like projects: each row opens its page in the Web
 * view, and folders gather them. Everything is edited in place rather than
 * in popovers, which would open under the page's native webview; the folder
 * picker is a native menu, which opens above it.
 */
export function WebAppsRailSection({
  webActive,
  onOpenWeb,
}: {
  /** The Web view is the one in the main area. */
  webActive: boolean;
  onOpenWeb: () => void;
}) {
  const { apps, active, collapsed } = useWebApps();
  const folders = webAppFolders(apps);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  /** The app a new folder is named for, or "" for a folder from the header. */
  const [naming, setNaming] = useState<string | null>(null);
  /** Folders named from the header that no app is filed under yet. */
  const [emptyFolders, setEmptyFolders] = useState<string[]>([]);
  const shownFolders = [
    ...folders,
    ...emptyFolders.filter((name) => !folders.includes(name)),
  ];

  const open = (app: WebApp) => {
    saveActiveWebApp(app.id);
    onOpenWeb();
  };

  const remove = (app: WebApp) => {
    if (!window.confirm(`Remove “${app.name}” and sign it out?`)) return;
    void invoke("web_embed_forget", { app: app.id }).catch(() => {});
    deleteWebApp(app.id);
  };

  const move = (app: WebApp, folder: string) => {
    if (folder === NEW_FOLDER) {
      setNaming(app.id);
      return;
    }
    moveWebAppToFolder(app.id, folder || undefined);
    setEmptyFolders((names) => names.filter((name) => name !== folder));
  };

  const nameFolder = (value: string) => {
    const name = normalizeWebAppFolder(value);
    const appId = naming;
    setNaming(null);
    if (!name) return;
    if (appId) moveWebAppToFolder(appId, name);
    else if (!shownFolders.includes(name))
      setEmptyFolders((names) => [...names, name]);
  };

  const row = (app: WebApp, sortable: SortableHandle) =>
    renaming === app.id ? (
      <InlineInput
        key={app.id}
        initial={app.name}
        label="App name"
        onCommit={(value) => {
          renameWebApp(app.id, value);
          setRenaming(null);
        }}
        onCancel={() => setRenaming(null)}
      />
    ) : (
      <WebAppRow
        key={app.id}
        app={app}
        sortable={sortable}
        selected={webActive && app.id === active.id}
        folders={shownFolders}
        removable={apps.length > 1}
        onOpen={() => open(app)}
        onRename={() => setRenaming(app.id)}
        onRemove={() => remove(app)}
        onMove={(folder) => move(app, folder)}
      />
    );

  const loose = apps.filter((app) => !app.folder);

  return (
    <div className="mb-2 shrink-0" data-web-apps-rail>
      <div className="flex items-center gap-1 px-3 pb-1.5 pt-1">
        <span className="min-w-0 flex-1 truncate px-1 text-xs leading-5 text-content/50">
          Web
        </span>
        <button
          type="button"
          title="New folder"
          aria-label="New web app folder"
          onClick={() => setNaming("")}
          className="grid size-5 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/8 hover:text-content"
        >
          <FolderPlus className="size-3.5" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          title="Add a web app"
          aria-label="Add a web app"
          onClick={() => setAdding(true)}
          className="grid size-5 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/8 hover:text-content"
        >
          <Plus className="size-3.5" strokeWidth={1.75} />
        </button>
      </div>
      <div className="flex flex-col gap-px px-2">
        {naming !== null ? (
          <InlineInput
            initial=""
            label="Folder name"
            placeholder={
              naming
                ? `Folder for ${apps.find((app) => app.id === naming)?.name ?? "this app"}`
                : "Folder name"
            }
            onCommit={nameFolder}
            onCancel={() => setNaming(null)}
          />
        ) : null}
        {shownFolders.map((folder) => {
          const members = apps.filter((app) => app.folder === folder);
          const folded = collapsed.has(folder);
          return (
            <div key={`folder:${folder}`} className="flex flex-col gap-px">
              {renamingFolder === folder ? (
                <InlineInput
                  initial={folder}
                  label="Folder name"
                  onCommit={(value) => {
                    const name = normalizeWebAppFolder(value);
                    if (name && members.length) renameWebAppFolder(folder, name);
                    else if (name)
                      setEmptyFolders((names) =>
                        names.map((entry) => (entry === folder ? name : entry)),
                      );
                    setRenamingFolder(null);
                  }}
                  onCancel={() => setRenamingFolder(null)}
                />
              ) : (
                <FolderRow
                  name={folder}
                  count={members.length}
                  folded={folded}
                  selected={
                    folded &&
                    webActive &&
                    members.some((app) => app.id === active.id)
                  }
                  onToggle={() => setWebAppFolderCollapsed(folder, !folded)}
                  onRename={() => setRenamingFolder(folder)}
                  onUngroup={() => {
                    ungroupWebAppFolder(folder);
                    setEmptyFolders((names) =>
                      names.filter((name) => name !== folder),
                    );
                  }}
                />
              )}
              {folded ? null : members.length ? (
                <SortableApps apps={members} indent>
                  {row}
                </SortableApps>
              ) : (
                <p className="py-1 pl-8 pr-2 text-[11px] leading-tight text-content/40">
                  Move an app here with its folder button.
                </p>
              )}
            </div>
          );
        })}
        <SortableApps apps={loose}>{row}</SortableApps>
        {adding ? (
          <input
            autoFocus
            aria-label="Address of the app to add"
            placeholder="notion.so, app.slack.com…"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            onChange={() => setAddError(false)}
            onBlur={() => {
              setAdding(false);
              setAddError(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") event.currentTarget.blur();
              if (event.key !== "Enter") return;
              if (!addWebApp(event.currentTarget.value)) {
                setAddError(true);
                return;
              }
              setAdding(false);
              onOpenWeb();
            }}
            className={`${inputClass} ${
              addError ? "ring-1 ring-red-500/70" : "ring-accent/40 focus:ring-1"
            }`}
          />
        ) : null}
      </div>
    </div>
  );
}

type SortableHandle = ReturnType<typeof useAnimatedReorder<string>>;

/** One list of apps, reordered by dragging within itself. */
function SortableApps({
  apps,
  indent = false,
  children,
}: {
  apps: WebApp[];
  indent?: boolean;
  children: (app: WebApp, sortable: SortableHandle) => ReactNode;
}) {
  const sortable = useAnimatedReorder(
    apps.map((app) => app.id),
    reorderWebApps,
    "y",
  );
  return (
    <div className={`flex flex-col gap-px ${indent ? "pl-4" : ""}`}>
      {apps.map((app) => children(app, sortable))}
    </div>
  );
}

function WebAppRow({
  app,
  sortable,
  selected,
  folders,
  removable,
  onOpen,
  onRename,
  onRemove,
  onMove,
}: {
  app: WebApp;
  sortable: SortableHandle;
  selected: boolean;
  folders: string[];
  removable: boolean;
  onOpen: () => void;
  onRename: () => void;
  onRemove: () => void;
  onMove: (folder: string) => void;
}) {
  return (
    <div
      ref={(el) => sortable.setItemRef(app.id, el)}
      data-selected={selected || undefined}
      className={`reorder-item project-reorder-item group relative flex h-8 cursor-default touch-none items-stretch rounded-md px-2 ${
        selected ? "bg-selection-strong text-content" : "opacity-65"
      }`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        if ((event.target as HTMLElement).closest("[data-no-drag]")) return;
        sortable.onItemPointerDown(app.id, event);
      }}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("[data-no-drag]")) return;
        if (sortable.consumeClick()) return;
        onOpen();
      }}
      onDoubleClick={onRename}
    >
      <button
        type="button"
        title={`${app.name}\n${app.url}`}
        aria-label={app.name}
        aria-current={selected ? "true" : undefined}
        className="flex min-w-0 flex-1 cursor-default items-center gap-2 text-left transition-[padding] duration-150 motion-reduce:transition-none group-hover:pr-[4.5rem] group-has-[button:focus-visible]:pr-[4.5rem]"
      >
        <span
          aria-hidden
          className="grid size-5 shrink-0 place-items-center rounded-md bg-content/12 text-[11px] font-semibold uppercase leading-none text-content/80"
        >
          {app.name.charAt(0)}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium leading-tight">
          {app.name}
        </span>
      </button>
      <div
        data-no-drag
        onPointerDown={(event) => event.stopPropagation()}
        className="absolute right-1 top-1/2 hidden -translate-y-1/2 items-center group-hover:flex group-has-[button:focus-visible]:flex"
      >
        <label
          title="Move to folder"
          className="relative grid size-6 place-items-center rounded-md text-content/55 hover:bg-content/8 hover:text-content"
        >
          <Folder className="size-3.5" strokeWidth={1.75} />
          <select
            aria-label={`Move ${app.name} to a folder`}
            value={app.folder ?? ""}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => onMove(event.target.value)}
            className="absolute inset-0 cursor-pointer opacity-0"
          >
            <option value="">No folder</option>
            {folders.map((folder) => (
              <option key={folder} value={folder}>
                {folder}
              </option>
            ))}
            <option value={NEW_FOLDER}>New folder…</option>
          </select>
        </label>
        <button
          type="button"
          title="Rename"
          aria-label={`Rename ${app.name}`}
          onClick={(event) => {
            event.stopPropagation();
            onRename();
          }}
          className="grid size-6 place-items-center rounded-md text-content/55 hover:bg-content/8 hover:text-content"
        >
          <Pencil className="size-3.5" strokeWidth={1.75} />
        </button>
        {removable ? (
          <button
            type="button"
            title="Remove and sign out"
            aria-label={`Remove ${app.name}`}
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
            className="grid size-6 place-items-center rounded-md text-content/55 hover:bg-content/8 hover:text-content"
          >
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function FolderRow({
  name,
  count,
  folded,
  selected,
  onToggle,
  onRename,
  onUngroup,
}: {
  name: string;
  count: number;
  folded: boolean;
  /** Folded over the app the Web view shows. */
  selected: boolean;
  onToggle: () => void;
  onRename: () => void;
  onUngroup: () => void;
}) {
  return (
    <div
      className={`group relative flex h-8 items-stretch rounded-md px-2 ${
        selected
          ? "bg-selection-strong text-content"
          : "text-content/80 hover:bg-content/5 hover:text-content"
      }`}
    >
      <button
        type="button"
        aria-expanded={!folded}
        title={name}
        onClick={onToggle}
        onDoubleClick={onRename}
        className="flex min-w-0 flex-1 cursor-default items-center gap-2 text-left group-hover:pr-12 group-has-[button:focus-visible]:pr-12"
      >
        <span className="grid size-5 shrink-0 place-items-center text-content/55">
          <Folder
            className="size-3.5 group-hover:hidden"
            strokeWidth={1.75}
          />
          {folded ? (
            <ChevronRight
              className="hidden size-3.5 group-hover:block"
              strokeWidth={1.75}
            />
          ) : (
            <ChevronDown
              className="hidden size-3.5 group-hover:block"
              strokeWidth={1.75}
            />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium leading-tight">
          {name}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-content/45 group-hover:hidden">
          {count}
        </span>
      </button>
      <div className="absolute right-1 top-1/2 hidden -translate-y-1/2 items-center group-hover:flex group-has-[button:focus-visible]:flex">
        <button
          type="button"
          title="Rename folder"
          aria-label={`Rename ${name}`}
          onClick={onRename}
          className="grid size-6 place-items-center rounded-md text-content/55 hover:bg-content/8 hover:text-content"
        >
          <Pencil className="size-3.5" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          title="Remove folder, keep its apps"
          aria-label={`Remove folder ${name}`}
          onClick={onUngroup}
          className="grid size-6 place-items-center rounded-md text-content/55 hover:bg-content/8 hover:text-content"
        >
          <X className="size-3.5" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}

function InlineInput({
  initial,
  label,
  placeholder,
  onCommit,
  onCancel,
}: {
  initial: string;
  label: string;
  placeholder?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  return (
    <input
      autoFocus
      defaultValue={initial}
      maxLength={40}
      aria-label={label}
      placeholder={placeholder}
      spellCheck={false}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={(event) => onCommit(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") onCancel();
      }}
      className={`${inputClass} ring-accent/40 focus:ring-1`}
    />
  );
}
