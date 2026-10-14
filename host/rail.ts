import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * The projects a person chose to show, in their order, as the desktop's rail
 * holds them; the desktop sends its own, and the browser app shows the same.
 * Each project may also have a background image, kept here for the browser.
 */

export type HostRailState = {
  /** Folders in rail order. */
  projects: string[];
  /** Folders taken off the rail. */
  archived: string[];
  /** When each folder's background last changed. */
  backgrounds: Record<string, number>;
  updatedAt: number;
};

const MAX_PROJECTS = 200;
const MAX_BACKGROUND_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function folders(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_PROJECTS) throw new Error(`Invalid ${what}`);
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !isAbsolute(entry) || entry.length > 1_000) throw new Error(`Invalid ${what}`);
    const path = entry.replace(/\/+$/, "") || "/";
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

export class HostRail {
  private state: HostRailState;

  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.state = this.load();
  }

  private get file() {
    return join(this.directory, "rail.json");
  }

  private load(): HostRailState {
    try {
      const value = JSON.parse(readFileSync(this.file, "utf8")) as HostRailState;
      return {
        projects: folders(value.projects, "rail"),
        archived: folders(value.archived, "rail"),
        backgrounds: value.backgrounds && typeof value.backgrounds === "object" ? value.backgrounds : {},
        updatedAt: Number(value.updatedAt) || 0,
      };
    } catch {
      return { projects: [], archived: [], backgrounds: {}, updatedAt: 0 };
    }
  }

  private save() {
    this.state.updatedAt = Date.now();
    writeFileSync(this.file, JSON.stringify(this.state, null, 2), { mode: 0o600 });
  }

  get(): HostRailState {
    return this.state;
  }

  /** Replaces the rail; a folder put back on it leaves the archive. */
  set(input: Record<string, unknown>): HostRailState {
    const projects = folders(input.projects, "rail");
    const archived = folders(input.archived ?? [], "archive").filter((path) => !projects.includes(path));
    this.state = { ...this.state, projects, archived };
    this.save();
    return this.state;
  }

  private backgroundStem(cwd: string) {
    return createHash("sha256").update(cwd).digest("hex").slice(0, 32);
  }

  setBackground(input: Record<string, unknown>): HostRailState {
    const [cwd] = folders([input.cwd], "folder");
    const extension = IMAGE_TYPES[String(input.mimeType)];
    if (!extension || typeof input.data !== "string") throw new Error("Choose a PNG, JPEG, WebP or GIF image");
    const bytes = Buffer.from(input.data, "base64");
    if (!bytes.length || bytes.length > MAX_BACKGROUND_BYTES) throw new Error("Background images are limited to 8 MB");
    this.removeBackgroundFiles(cwd);
    writeFileSync(join(this.directory, `${this.backgroundStem(cwd)}.${extension}`), bytes, { mode: 0o600 });
    this.state.backgrounds = { ...this.state.backgrounds, [cwd]: Date.now() };
    this.save();
    return this.state;
  }

  clearBackground(input: Record<string, unknown>): HostRailState {
    const [cwd] = folders([input.cwd], "folder");
    this.removeBackgroundFiles(cwd);
    const { [cwd]: _, ...rest } = this.state.backgrounds;
    this.state.backgrounds = rest;
    this.save();
    return this.state;
  }

  private removeBackgroundFiles(cwd: string) {
    for (const extension of Object.values(IMAGE_TYPES))
      rmSync(join(this.directory, `${this.backgroundStem(cwd)}.${extension}`), { force: true });
  }

  /** The image file and its type for a folder's background. */
  background(cwd: string): { path: string; type: string } | undefined {
    if (!this.state.backgrounds[cwd]) return undefined;
    for (const [type, extension] of Object.entries(IMAGE_TYPES)) {
      const path = join(this.directory, `${this.backgroundStem(cwd)}.${extension}`);
      if (existsSync(path)) return { path, type };
    }
    return undefined;
  }
}
