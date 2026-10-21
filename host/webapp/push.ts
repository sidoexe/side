import { useEffect, useState } from "react";
import { LOCAL, rpc } from "./api";
import { model, useModel } from "./store";

type PushState = "working" | "on" | "off" | "denied" | "install" | "unsupported";

/** A push subscription is bound to one host's key, so each machine gets
 * its own registration of the worker: this host's at `/web/`, another
 * machine's at `/web/m/<id>/`, which also tells the worker which machine a
 * notification is about. */
const scopeOf = (machineId: string) => (machineId === LOCAL ? "/web/" : `/web/m/${machineId}/`);

const keyBytes = (publicKey: string) => Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function subscribe(machineId: string) {
  const registration = await navigator.serviceWorker.register("/web/sw.js", { scope: scopeOf(machineId) });
  const existing = await registration.pushManager.getSubscription();
  const { publicKey } = await rpc<{ publicKey: string }>("push.key", {}, machineId);
  const subscription =
    existing ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  await rpc("push.subscribe", { subscription: subscription.toJSON() }, machineId);
}

async function unsubscribe(machineId: string) {
  const registration = await navigator.serviceWorker.getRegistration(scopeOf(machineId));
  const existing = await registration?.pushManager.getSubscription();
  if (!existing) return;
  await rpc("push.unsubscribe", { endpoint: existing.endpoint }, machineId).catch(() => undefined);
  await existing.unsubscribe();
}

/** The machines that can send notifications, and are reachable now. */
const pushing = () => model.state.machines.filter((m) => !m.offline && model.can("push", m.id)).map((m) => m.id);

/** Notifications from every machine, as the phone app's: on iPhone they
 * need the page on the Home Screen, elsewhere a browser with Web Push. */
export function useNotifications() {
  const app = useModel();
  const available = app.can("push");
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
  // A machine added while notifications are on gets them too.
  const machines = pushing().join(",");
  useEffect(() => {
    if (state !== "on") return;
    for (const machineId of machines.split(",").filter(Boolean)) void subscribe(machineId).catch(() => undefined);
  }, [state, machines]);
  const toggle = async () => {
    if (state !== "on" && state !== "off") return;
    const previous = state;
    setState("working");
    try {
      if (previous === "on") {
        await Promise.all(model.state.machines.map((m) => unsubscribe(m.id).catch(() => undefined)));
        return setState("off");
      }
      if ((await Notification.requestPermission()) !== "granted") return setState("denied");
      await subscribe(LOCAL);
      await Promise.all(pushing().filter((id) => id !== LOCAL).map((id) => subscribe(id).catch(() => undefined)));
      setState("on");
    } catch {
      setState(previous);
    }
  };
  return { state, toggle };
}
