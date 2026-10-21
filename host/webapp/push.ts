import { useEffect, useState } from "react";
import { rpc } from "./api";

type PushState = "working" | "on" | "off" | "denied" | "install" | "unsupported";

/** Notifications from the host, as the phone app's: on iPhone they need the
 * page on the Home Screen, elsewhere a browser that supports Web Push. */
export function useNotifications(available: boolean) {
  const [state, setState] = useState<PushState>("working");
  const standalone =
    matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  useEffect(() => {
    if (!available) return setState("unsupported");
    if (!("serviceWorker" in navigator) || !("PushManager" in window))
      return setState(/iPhone|iPad/.test(navigator.userAgent) && !standalone ? "install" : "unsupported");
    if (Notification.permission === "denied") return setState("denied");
    navigator.serviceWorker
      .register("/web/sw.js", { scope: "/web/" })
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => setState(subscription ? "on" : "off"), () => setState("off"));
  }, [available, standalone]);
  const toggle = async () => {
    if (state !== "on" && state !== "off") return;
    const previous = state;
    setState("working");
    try {
      const registration = await navigator.serviceWorker.register("/web/sw.js", { scope: "/web/" });
      await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      if (previous === "on") {
        if (existing) {
          await rpc("push.unsubscribe", { endpoint: existing.endpoint }).catch(() => undefined);
          await existing.unsubscribe();
        }
        return setState("off");
      }
      if ((await Notification.requestPermission()) !== "granted") return setState("denied");
      const { publicKey } = await rpc<{ publicKey: string }>("push.key");
      const key = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      const subscription = existing ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
      await rpc("push.subscribe", { subscription: subscription.toJSON() });
      setState("on");
    } catch {
      setState(previous);
    }
  };
  return { state, toggle };
}
