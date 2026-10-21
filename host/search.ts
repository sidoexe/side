import type { HostStore } from "./store";

export type HostSearchHit = {
  kind: "conversation" | "message";
  projectId: string;
  /** The project's folder on this host. */
  cwd: string;
  sessionId: string;
  harness: string;
  title: string;
  updatedAt: number;
  blockId?: string;
  role?: string;
  preview: string;
};

const MAX_HITS = 200;
const PREVIEW_CHARS = 160;
const SEARCHED_ROLES = new Set(["user", "assistant", "plan"]);

/** The words around the first match, on one line. */
function preview(text: string, at: number, length: number): string {
  const start = Math.max(0, at - 50);
  const end = Math.min(text.length, at + length + PREVIEW_CHARS - 50);
  const middle = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${middle}${end < text.length ? "…" : ""}`;
}

/** As the desktop's session_search, over this host's conversations: their
 * titles, then what was said in them, newest first, archived ones left out. */
export function searchHostSessions(store: HostStore, query: unknown): { hits: HostSearchHit[]; truncated: boolean } {
  if (typeof query !== "string" || !query.trim()) return { hits: [], truncated: false };
  const needle = query.trim().toLowerCase();
  const hits: HostSearchHit[] = [];
  const summaries = store
    .projects()
    .flatMap((project) => store.summaries(project.id).map((summary) => ({ project, summary })))
    .filter(({ summary }) => !summary.archived && !summary.draft)
    .sort((a, b) => b.summary.updatedAt - a.summary.updatedAt);
  for (const { project, summary } of summaries) {
    const base = {
      projectId: project.id,
      cwd: project.cwd,
      sessionId: summary.id,
      harness: summary.harness,
      title: summary.title,
      updatedAt: summary.updatedAt,
    };
    if (summary.title.toLowerCase().includes(needle)) hits.push({ ...base, kind: "conversation", preview: summary.title });
    for (const block of store.session(summary.id).session.blocks) {
      if (!SEARCHED_ROLES.has(block.role) || block.internal) continue;
      const at = block.text.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      hits.push({ ...base, kind: "message", blockId: block.id, role: block.role, preview: preview(block.text, at, needle.length) });
      if (hits.length >= MAX_HITS) return { hits, truncated: true };
    }
    if (hits.length >= MAX_HITS) return { hits: hits.slice(0, MAX_HITS), truncated: true };
  }
  return { hits, truncated: false };
}
