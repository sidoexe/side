import { useEffect, useSyncExternalStore } from "react";
import {
  refreshWebAppIcon,
  subscribeWebAppIcons,
  webAppIcon,
} from "../model/webAppIcons";

/** The site's own icon, or the app's initial until it is known. */
export function WebAppIcon({
  name,
  url,
  className = "size-5",
}: {
  name: string;
  url: string;
  className?: string;
}) {
  const icon = useSyncExternalStore(subscribeWebAppIcons, () =>
    webAppIcon(url),
  );
  useEffect(() => refreshWebAppIcon(url), [url]);
  return icon ? (
    <img
      aria-hidden
      alt=""
      src={icon}
      draggable={false}
      className={`${className} shrink-0 rounded-[4px] object-contain`}
    />
  ) : (
    <span
      aria-hidden
      className={`${className} grid shrink-0 place-items-center rounded-md bg-content/12 text-[11px] font-semibold uppercase leading-none text-content/80`}
    >
      {name.charAt(0)}
    </span>
  );
}
