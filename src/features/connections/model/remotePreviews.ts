import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { openWebAppAt, OPEN_WEB_EVENT } from "../../web-apps/model/webApps";
import { remoteRequest } from "./connections";
import { localTarget } from "./localTarget";
import type { RemoteMachine } from "./protocol";

/**
 * Opens a `localhost` link from a session on another machine: that
 * machine's host publishes the port on its tailnet, and the page opens in
 * the Web view, as a web app named after the machine and port (web app
 * names stay within the host's 40 characters). Returns
 * false for links it does not take, which then open as usual.
 */
export function openRemotePreview(machine: RemoteMachine, href: string): boolean {
  const target = localTarget(href);
  if (!target) return false;
  void remoteRequest<{ url: string }>(machine.id, "previews.open", target).then(
    ({ url }) => {
      const app = openWebAppAt(url, `${machine.name.slice(0, 30)}:${target.port}`);
      // An app already open stays on its page unless sent to this one.
      void invoke("web_embed_reload", { app: app.id, home: url }).catch(() => {});
      window.dispatchEvent(new Event(OPEN_WEB_EVENT));
    },
    (error) => {
      console.error("Failed to open the preview:", error);
      void openUrl(href).catch(() => undefined);
    },
  );
  return true;
}
