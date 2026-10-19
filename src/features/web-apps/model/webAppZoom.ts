/** Each web app's page zoom on this desktop, by app id; 1 is 100%. Not
 * synced: the right zoom depends on the screen. */
const ZOOM_KEY = "monocode.webApps.zoom";

/** The steps the zoom buttons and chords walk, as in a browser. */
export const WEB_APP_ZOOM_STEPS = [
  0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3,
] as const;

const CHANGED = "monocode:web-app-zoom-changed";

function readAll(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(ZOOM_KEY) ?? "");
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, number>)
      : {};
  } catch {
    return {};
  }
}

export function loadWebAppZoom(id: string): number {
  const zoom = readAll()[id];
  return typeof zoom === "number" && Number.isFinite(zoom) && zoom > 0
    ? zoom
    : 1;
}

export function saveWebAppZoom(id: string, zoom: number) {
  const all = readAll();
  if (zoom === 1) delete all[id];
  else all[id] = zoom;
  try {
    localStorage.setItem(ZOOM_KEY, JSON.stringify(all));
  } catch {
    // private mode / quota
  }
  window.dispatchEvent(new Event(CHANGED));
}

export function subscribeWebAppZoom(onChange: () => void): () => void {
  window.addEventListener(CHANGED, onChange);
  return () => window.removeEventListener(CHANGED, onChange);
}

/** The next step from `zoom` in `direction`, or 1 for a reset. */
export function steppedWebAppZoom(
  zoom: number,
  direction: "in" | "out" | "reset",
): number {
  if (direction === "reset") return 1;
  const steps = WEB_APP_ZOOM_STEPS;
  if (direction === "in")
    return steps.find((step) => step > zoom + 0.001) ?? steps[steps.length - 1];
  return [...steps].reverse().find((step) => step < zoom - 0.001) ?? steps[0];
}
