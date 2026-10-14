import { useMemo, useSyncExternalStore } from "react";
import {
  loadActiveWebApp,
  loadWebApps,
  subscribeWebApps,
  webAppsSnapshot,
} from "../model/webApps";

/** The web apps in their rail order, and the one the Web view shows. */
export function useWebApps() {
  const snapshot = useSyncExternalStore(subscribeWebApps, webAppsSnapshot);
  return useMemo(() => {
    const apps = loadWebApps();
    return { apps, active: apps.find((app) => app.id === loadActiveWebApp(apps))! };
  }, [snapshot]);
}
