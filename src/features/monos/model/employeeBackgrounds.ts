import { invoke } from "@tauri-apps/api/core";
import { clearProjectChatBackground } from "../../projects/model/chatBackground";
import {
  clearProjectChatBackgroundSetting,
  loadProjectChatBackgroundSettings,
  PROJECT_CHAT_BACKGROUND_CHANGED,
  saveProjectChatBackgroundSettings,
  type ProjectChatBackgroundChange,
} from "../../projects/model/projectChatBackground";
import type { RemoteMachine } from "../../connections/model/protocol";
import { CHAT_BACKGROUND_OPACITY_DEFAULT } from "../../settings/model/appearance";
import { listMonos, type Mono } from "./mono";
import { monoBackgroundKey } from "./monoBackground";

/**
 * Keeps each employee's background image the same on every desktop, through
 * the home machine's host. A desktop that picks or removes an image stamps
 * the change with its time and sends it; the host keeps the newest change,
 * and every other desktop takes it. Employees kept on this computer only
 * keep theirs here.
 */

/** When this desktop's copy last changed; `dirty` until the host has it. */
export type BackgroundMark = { updatedAt: number; dirty?: true };

/** The host's stamp: no type once the image was removed. */
export type HostBackgroundStamp = { updatedAt: number; mimeType?: string };

type HostBackground = { updatedAt: number; mimeType: string; data: string } | null;

type Request = <T>(machine: RemoteMachine, method: string, params?: unknown) => Promise<T>;

const MARKS_KEY = "side.employeeBackgrounds.v1";
/** What the host takes; larger images stay on the desktop that chose them. */
const MAX_BYTES = 8 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Whether this desktop sends its copy, takes the host's, or has nothing to do. */
export function backgroundStep(
  mark: BackgroundMark | undefined,
  host: HostBackgroundStamp | undefined,
  hasLocal: boolean,
): "push" | "pull" | "none" {
  if (mark?.dirty) return host && host.updatedAt > mark.updatedAt ? "pull" : "push";
  if (host && host.updatedAt > (mark?.updatedAt ?? 0)) return "pull";
  // An image from before the host kept them: shared the first time.
  if (!host && !mark && hasLocal) return "push";
  return "none";
}

function loadMarks(): Record<string, BackgroundMark> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(MARKS_KEY) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, BackgroundMark>)
      : {};
  } catch {
    return {};
  }
}

function saveMarks(marks: Record<string, BackgroundMark>) {
  try {
    localStorage.setItem(MARKS_KEY, JSON.stringify(marks));
  } catch {
    // private mode / quota
  }
}

function setMark(id: string, mark: BackgroundMark) {
  saveMarks({ ...loadMarks(), [id]: mark });
}

const MONO_PREFIX = monoBackgroundKey("");
/** Set while this module writes a background it took from the host, so the
 * write does not read as a change made here. */
let applying = false;

/** Stamps a background picked or removed on this desktop, for the next sync. */
function noteLocalChange(event: Event) {
  const { project, imageChanged } =
    (event as CustomEvent<ProjectChatBackgroundChange | undefined>).detail ?? {};
  if (applying || !imageChanged || !project?.startsWith(MONO_PREFIX)) return;
  setMark(project.slice(MONO_PREFIX.length), { updatedAt: Date.now(), dirty: true });
}

function base64Size(data: string): number {
  return Math.floor((data.length * 3) / 4);
}

async function push(
  request: Request,
  home: RemoteMachine,
  mono: Mono,
  mark: BackgroundMark | undefined,
): Promise<void> {
  const updatedAt = mark?.updatedAt ?? Date.now();
  const stored = loadProjectChatBackgroundSettings(monoBackgroundKey(mono.id));
  let image: { mimeType: string; data: string } | undefined;
  if (stored) {
    const mimeType = MIME_TYPES[stored.path.split(".").pop()?.toLowerCase() ?? ""];
    const data = mimeType
      ? await invoke<string>("read_file_base64", { path: stored.path }).catch(() => undefined)
      : undefined;
    if (!mimeType || !data || base64Size(data) > MAX_BYTES) {
      // The host cannot take it: it stays on this desktop, asked no more.
      setMark(mono.id, { updatedAt });
      return;
    }
    image = { mimeType, data };
  }
  const kept = await request<HostBackgroundStamp>(home, "employees.setBackground", {
    mono: mono.id,
    updatedAt,
    ...(image ?? {}),
  });
  // A newer change the host kept instead is taken on the next pass.
  setMark(mono.id, { updatedAt: Math.min(updatedAt, kept.updatedAt) });
}

async function pull(
  request: Request,
  home: RemoteMachine,
  mono: Mono,
  stamp: HostBackgroundStamp,
): Promise<void> {
  const key = monoBackgroundKey(mono.id);
  const image = stamp.mimeType
    ? await request<HostBackground>(home, "employees.background", { mono: mono.id })
    : null;
  // Its file is missing on the host: nothing to take.
  if (stamp.mimeType && !image) return;
  applying = true;
  try {
    if (image && EXTENSIONS[image.mimeType]) {
      const path = await invoke<string>("save_project_chat_background_data", {
        project: key,
        extension: EXTENSIONS[image.mimeType],
        data: image.data,
      });
      // Only the image is shared: the look chosen here stays.
      const look = loadProjectChatBackgroundSettings(key) ?? {
        emptyOpacity: CHAT_BACKGROUND_OPACITY_DEFAULT,
        sessionOpacity: CHAT_BACKGROUND_OPACITY_DEFAULT,
        scope: "all" as const,
        effect: "gradient-blur" as const,
      };
      saveProjectChatBackgroundSettings(key, { ...look, path }, true);
    } else if (loadProjectChatBackgroundSettings(key)) {
      await clearProjectChatBackground(key).catch(() => {});
      clearProjectChatBackgroundSetting(key);
    }
  } finally {
    applying = false;
  }
  setMark(mono.id, { updatedAt: image?.updatedAt ?? stamp.updatedAt });
}

/** One pass over every shared employee's background. */
export async function syncEmployeeBackgrounds(
  request: Request,
  home: RemoteMachine,
  monos: readonly Mono[] = listMonos(),
): Promise<void> {
  const stamps = await request<Record<string, HostBackgroundStamp>>(
    home,
    "employees.backgrounds",
  );
  for (const mono of monos) {
    if (mono.localOnly) continue;
    const mark = loadMarks()[mono.id];
    const stamp = stamps[mono.id];
    const hasLocal = !!loadProjectChatBackgroundSettings(monoBackgroundKey(mono.id));
    const step = backgroundStep(mark, stamp, hasLocal);
    if (step === "push") await push(request, home, mono, mark);
    else if (step === "pull") await pull(request, home, mono, stamp!);
  }
}

/** Notes this desktop's own changes as they are made. */
export function watchEmployeeBackgrounds(onChange: () => void): () => void {
  const listener = (event: Event) => {
    if (applying) return;
    noteLocalChange(event);
    const project = (event as CustomEvent<ProjectChatBackgroundChange | undefined>).detail
      ?.project;
    if (project?.startsWith(MONO_PREFIX)) onChange();
  };
  window.addEventListener(PROJECT_CHAT_BACKGROUND_CHANGED, listener);
  return () => window.removeEventListener(PROJECT_CHAT_BACKGROUND_CHANGED, listener);
}
