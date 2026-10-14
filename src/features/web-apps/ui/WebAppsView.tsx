import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { OverlayNav } from "../../../app/shell/TitleBar";
import { WindowControls } from "../../../app/shell/WindowControls";
import { ExternalLink, Globe, RefreshCw } from "../../../shared/ui/icons";
import { IS_MAC } from "../../../platform/tauri/platform";
import {
  loadUiScale,
  UI_SCALE_CHANGE_EVENT,
} from "../../settings/model/uiScale";
import { useWebApps } from "../hooks/useWebApps";

type Props = {
  besideRail?: boolean;
  compactRail?: boolean;
  onClose: () => void;
  onToggleSidebar?: () => void;
};

const reload = (app: string, home?: string) =>
  void invoke("web_embed_reload", { app, home: home ?? null }).catch(() => {});

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
        <button
          type="button"
          title={`${active.url}\nBack to the home page`}
          onClick={() => reload(active.id, active.url)}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 text-left text-[13px]"
        >
          <Globe
            className="size-3.5 shrink-0 text-content/45"
            strokeWidth={1.75}
          />
          <span className="min-w-0 truncate text-content">{active.name}</span>
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
