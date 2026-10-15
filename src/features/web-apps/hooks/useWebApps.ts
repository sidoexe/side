import { useMemo, useSyncExternalStore } from "react";
import {
  loadActiveWebApp,
  loadCollapsedWebAppFolders,
  loadWebApps,
  subscribeWebApps,
  webAppsSnapshot,
} from "../model/webApps";

/** The web apps in their rail order, the one the Web view shows, and the
 * folders folded in the rail. */
export function useWebApps() {
  const snapshot = useSyncExternalStore(subscribeWebApps, webAppsSnapshot);
  return useMemo(() => {
    const apps = loadWebApps();
    return {
      apps,
      active: apps.find((app) => app.id === loadActiveWebApp(apps))!,
      collapsed: loadCollapsedWebAppFolders(),
    };
  }, [snapshot]);
}
