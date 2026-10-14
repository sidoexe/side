import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus, X } from "../../shared/ui/icons";
import { useAnimatedReorder } from "../../shared/hooks/useAnimatedReorder";
import { useWebApps } from "../../features/web-apps/hooks/useWebApps";
import {
  addWebApp,
  deleteWebApp,
  renameWebApp,
  reorderWebApps,
  saveActiveWebApp,
  type WebApp,
} from "../../features/web-apps/model/webApps";

/**
 * The web apps, listed like projects: each row opens its page in the Web
 * view. Everything is edited in place rather than in popovers, which would
 * open under the page's native webview.
 */
export function WebAppsRailSection({
  webActive,
  onOpenWeb,
}: {
  /** The Web view is the one in the main area. */
  webActive: boolean;
  onOpenWeb: () => void;
}) {
  const { apps, active } = useWebApps();
  const sortable = useAnimatedReorder(
    apps.map((app) => app.id),
    reorderWebApps,
    "y",
  );
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);

  const open = (app: WebApp) => {
    saveActiveWebApp(app.id);
    onOpenWeb();
  };

  const remove = (app: WebApp) => {
    if (!window.confirm(`Remove “${app.name}” and sign it out?`)) return;
    void invoke("web_embed_forget", { app: app.id }).catch(() => {});
    deleteWebApp(app.id);
  };

  return (
    <div className="mb-2 shrink-0" data-web-apps-rail>
      <div className="flex items-center gap-1 px-3 pb-1.5 pt-1">
        <span className="min-w-0 flex-1 truncate px-1 text-xs leading-5 text-content/50">
          Web
        </span>
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
        {apps.map((app) => {
          const selected = webActive && app.id === active.id;
          if (renaming === app.id)
            return (
              <input
                key={app.id}
                autoFocus
                defaultValue={app.name}
                maxLength={40}
                aria-label="App name"
                spellCheck={false}
                onFocus={(event) => event.currentTarget.select()}
                onBlur={(event) => {
                  renameWebApp(app.id, event.target.value);
                  setRenaming(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") setRenaming(null);
                }}
                className="h-8 rounded-md bg-content/8 px-2 text-sm text-content outline-none ring-accent/40 focus:ring-1"
              />
            );
          return (
            <div
              key={app.id}
              ref={(el) => sortable.setItemRef(app.id, el)}
              data-selected={selected || undefined}
              className={`reorder-item project-reorder-item group relative flex h-8 cursor-default touch-none items-stretch rounded-md px-2 ${
                selected ? "bg-selection-strong text-content" : "opacity-65"
              }`}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                if ((event.target as HTMLElement).closest("[data-no-drag]"))
                  return;
                sortable.onItemPointerDown(app.id, event);
              }}
              onClick={(event) => {
                if ((event.target as HTMLElement).closest("[data-no-drag]"))
                  return;
                if (sortable.consumeClick()) return;
                open(app);
              }}
              onDoubleClick={() => setRenaming(app.id)}
            >
              <button
                type="button"
                title={`${app.name}\n${app.url}\nDouble-click to rename`}
                aria-label={app.name}
                aria-current={selected ? "true" : undefined}
                className="flex min-w-0 flex-1 cursor-default items-center gap-2 text-left transition-[padding] duration-150 motion-reduce:transition-none group-hover:pr-6 group-has-[:focus-visible]:pr-6"
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
              {apps.length > 1 ? (
                <button
                  type="button"
                  data-no-drag
                  title="Remove and sign out"
                  aria-label={`Remove ${app.name}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    remove(app);
                  }}
                  className="absolute right-1 top-1/2 hidden size-6 -translate-y-1/2 place-items-center rounded-md text-content/55 hover:bg-content/8 hover:text-content group-hover:grid group-has-[:focus-visible]:grid"
                >
                  <X className="size-3.5" strokeWidth={1.75} />
                </button>
              ) : null}
            </div>
          );
        })}
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
            className={`h-8 rounded-md bg-content/8 px-2 text-sm text-content outline-none placeholder:text-content/40 ${
              addError ? "ring-1 ring-red-500/70" : "ring-accent/40 focus:ring-1"
            }`}
          />
        ) : null}
      </div>
    </div>
  );
}
