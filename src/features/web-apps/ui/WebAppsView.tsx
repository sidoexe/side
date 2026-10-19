import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { OverlayNav } from "../../../app/shell/TitleBar";
import { WindowControls } from "../../../app/shell/WindowControls";
import {
  ExternalLink,
  Minus,
  Pencil,
  Plus,
  RefreshCw,
} from "../../../shared/ui/icons";
import { IS_MAC } from "../../../platform/tauri/platform";
import {
  loadUiScale,
  UI_SCALE_CHANGE_EVENT,
} from "../../settings/model/uiScale";
import { useWebApps } from "../hooks/useWebApps";
import { renameWebApp } from "../model/webApps";
import {
  loadWebAppZoom,
  saveWebAppZoom,
  steppedWebAppZoom,
  subscribeWebAppZoom,
} from "../model/webAppZoom";
import { WebAppIcon } from "./WebAppIcon";

type Props = {
  besideRail?: boolean;
  compactRail?: boolean;
  onClose: () => void;
  onToggleSidebar?: () => void;
};

const reload = (app: string, home?: string) =>
  void invoke("web_embed_reload", { app, home: home ?? null }).catch(() => {});

/** Step `app`'s page zoom; a reset also undoes a trackpad pinch. */
function zoomApp(app: string, direction: "in" | "out" | "reset") {
  const zoom = steppedWebAppZoom(loadWebAppZoom(app), direction);
  saveWebAppZoom(app, zoom);
  void invoke("web_embed_zoom", {
    app,
    zoom,
    resetPinch: direction === "reset",
  }).catch(() => {});
}

/**
 * The active web app (picked in the rail), in a native webview laid over this
 * view's body; each app is signed in to its own account. The body only
 * reserves the space: the Rust side owns the pages, which outlive the view so
 * returning is instant and keeps the logins.
 */
export function WebAppsView({
  besideRail = false,
  compactRail = false,
  onClose,
  onToggleSidebar,
}: Props) {
  const slotRef = useRef<HTMLDivElement>(null);
  const { active } = useWebApps();
  const [renaming, setRenaming] = useState(false);
  const zoom = useSyncExternalStore(subscribeWebAppZoom, () =>
    loadWebAppZoom(active.id),
  );
  // Picking another app in the rail drops an unfinished rename.
  useEffect(() => setRenaming(false), [active.id]);

  // Cmd +/−/0 pressed inside the page, which keeps them from sIDE's own keys.
  useEffect(() => {
    if (!isTauri()) return;
    const stop = listen<{ app: string; action: string }>(
      "web_embed_zoom_key",
      ({ payload }) => {
        if (
          payload.action === "in" ||
          payload.action === "out" ||
          payload.action === "reset"
        )
          zoomApp(payload.app, payload.action);
      },
    );
    return () => void stop.then((unlisten) => unlisten()).catch(() => {});
  }, []);

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    let frame = 0;
    const place = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = slot.getBoundingClientRect();
        // The app zooms its own webview; the child is placed in window
        // points, so CSS pixels scale by the UI zoom.
        const scale = loadUiScale();
        void invoke("web_embed_show", {
          app: active.id,
          url: active.url,
          zoom: loadWebAppZoom(active.id),
          bounds: {
            x: box.left * scale,
            y: box.top * scale,
            width: box.width * scale,
            height: box.height * scale,
          },
        }).catch(() => {});
      });
    };
    const observer = new ResizeObserver(place);
    observer.observe(slot);
    window.addEventListener("resize", place);
    window.addEventListener(UI_SCALE_CHANGE_EVENT, place);
    place();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener(UI_SCALE_CHANGE_EVENT, place);
      void invoke("web_embed_hide").catch(() => {});
    };
  }, [active.id, active.url]);

  return (
    <div
      role="region"
      aria-label={active.name}
      data-app-web
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
          <WebAppIcon name={active.name} url={active.url} className="size-4" />
          {renaming ? (
            <input
              autoFocus
              defaultValue={active.name}
              maxLength={40}
              aria-label="App name"
              spellCheck={false}
              onFocus={(event) => event.currentTarget.select()}
              onBlur={(event) => {
                renameWebApp(active.id, event.target.value);
                setRenaming(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") setRenaming(false);
              }}
              className="h-6 w-56 min-w-0 rounded-md bg-content/10 px-2 text-[13px] text-content outline-none ring-accent/40 focus:ring-1"
            />
          ) : (
            <button
              type="button"
              title={`${active.url}\nClick for the home page · double-click to rename`}
              onClick={() => reload(active.id, active.url)}
              onDoubleClick={() => setRenaming(true)}
              className="min-w-0 truncate text-left text-content"
            >
              {active.name}
            </button>
          )}
        </div>
        <div className="mr-1 flex shrink-0 items-center">
          <button
            type="button"
            title="Zoom out (⌘−)"
            aria-label={`Zoom out of ${active.name}`}
            onClick={() => zoomApp(active.id, "out")}
            className="grid size-6 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content"
          >
            <Minus className="size-3.5" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            title="Reset zoom (⌘0)"
            aria-label={`Reset the zoom of ${active.name}`}
            onClick={() => zoomApp(active.id, "reset")}
            className="h-6 min-w-10 rounded-md px-1 text-[11px] tabular-nums text-content/55 hover:bg-content/10 hover:text-content"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            title="Zoom in (⌘+)"
            aria-label={`Zoom in on ${active.name}`}
            onClick={() => zoomApp(active.id, "in")}
            className="grid size-6 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content"
          >
            <Plus className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>
        <button
          type="button"
          title="Rename"
          aria-label={`Rename ${active.name}`}
          onClick={() => setRenaming(true)}
          className="grid size-6 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content"
        >
          <Pencil className="size-3.5" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          title="Open in browser"
          aria-label={`Open ${active.name} in browser`}
          onClick={() => void openUrl(active.url).catch(() => {})}
          className="grid size-6 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content"
        >
          <ExternalLink className="size-3.5" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          title="Reload"
          aria-label={`Reload ${active.name}`}
          onClick={() => reload(active.id)}
          className="mr-2 grid size-6 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content"
        >
          <RefreshCw className="size-3.5" strokeWidth={1.75} />
        </button>
        {IS_MAC ? null : <WindowControls />}
      </div>
      <div ref={slotRef} className="min-h-0 flex-1" />
    </div>
  );
}
