import { useCallback, useEffect, useState } from "react";
import type { HostDirectory } from "../../src/features/connections/model/protocol";
import type { CheckpointFile, CheckpointFileDiff, CheckpointStatus } from "../../src/features/sessions/model/checkpoint";
import type { GitDiffIndex } from "../../src/platform/tauri/fs";
import { lineDiff } from "../../src/features/source-control/model/lineDiff";
import { rpc } from "./api";
import { tilde, usePoll } from "./ui";

/** A workspace command of the host, the same ones the desktop runs there. */
export const workspace = <T,>(command: string, args: Record<string, unknown>) =>
  rpc<T>("workspace.run", { command, args });

type DiffLine = { kind: "add" | "del" | "context" | "gap"; text: string; number?: number };

/** A unified diff with three lines of context around each change. */
export function unifiedDiff(original: string, current: string, context = 3): DiffLine[] {
  const a = original.split("\n");
  const b = current.split("\n");
  const lineAt = (text: string, offset: number) => text.slice(0, offset).split("\n").length - 1;
  const hunks = lineDiff(original, current).map((change) => ({
    fromA: lineAt(original, change.fromA),
    toA: change.toA > change.fromA ? lineAt(original, change.toA - 1) + 1 : lineAt(original, change.fromA),
    fromB: lineAt(current, change.fromB),
    toB: change.toB > change.fromB ? lineAt(current, change.toB - 1) + 1 : lineAt(current, change.fromB),
  }));
  const out: DiffLine[] = [];
  let shownB = 0;
  hunks.forEach((hunk, index) => {
    const start = Math.max(shownB, hunk.fromB - context);
    if (start > shownB && out.length) out.push({ kind: "gap", text: "" });
    for (let line = start; line < hunk.fromB; line++) out.push({ kind: "context", text: b[line], number: line + 1 });
    for (let line = hunk.fromA; line < hunk.toA; line++) out.push({ kind: "del", text: a[line] });
    for (let line = hunk.fromB; line < hunk.toB; line++) out.push({ kind: "add", text: b[line], number: line + 1 });
    const next = hunks[index + 1];
    const end = Math.min(b.length, hunk.toB + context, next ? next.fromB : Infinity);
    for (let line = hunk.toB; line < end; line++) out.push({ kind: "context", text: b[line], number: line + 1 });
    shownB = end;
  });
  return out;
}

export function DiffView({ original, current, binary, tooLarge }: { original: string; current: string; binary?: boolean; tooLarge?: boolean }) {
  if (binary) return <div className="muted diff-note">Binary file</div>;
  if (tooLarge) return <div className="muted diff-note">Too large to show</div>;
  const lines = unifiedDiff(original, current);
  if (!lines.length) return <div className="muted diff-note">No changes</div>;
  return (
    <div className="diff-body">
      {lines.map((line, index) =>
        line.kind === "gap" ? (
          <div key={index} className="diff-gap">⋯</div>
        ) : (
          <div key={index} className={`diff-line ${line.kind}`}>
            <span className="diff-num">{line.number ?? ""}</span>
            <span className="diff-mark">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
            <span className="diff-text">{line.text}</span>
          </div>
        ),
      )}
    </div>
  );
}

const fileName = (relative: string) => relative.split("/").pop() ?? relative;
const fileDir = (relative: string) => relative.split("/").slice(0, -1).join("/");
const STATUS_LETTER: Record<string, string> = { modified: "M", added: "A", deleted: "D", untracked: "U", renamed: "R" };

function FileRow({
  relative,
  status,
  additions,
  deletions,
  open,
  onToggle,
  actions,
}: {
  relative: string;
  status: string;
  additions: number;
  deletions: number;
  open: boolean;
  onToggle: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <div className={`file-row${open ? " open" : ""}`}>
      <button className="file-main" onClick={onToggle}>
        <span className="file-name ellipsis">{fileName(relative)}</span>
        <span className="file-dir ellipsis">{fileDir(relative)}</span>
        {additions ? <span className="add">+{additions}</span> : null}
        {deletions ? <span className="del">−{deletions}</span> : null}
        <span className={`file-status ${status}`}>{STATUS_LETTER[status] ?? status.slice(0, 1).toUpperCase()}</span>
      </button>
      {actions ? <span className="file-actions">{actions}</span> : null}
    </div>
  );
}

/** The review card after a turn: the files it changed, each kept or undone. */
export function ReviewCard({ sessionId, revision }: { sessionId: string; revision: number }) {
  const [status, setStatus] = useState<CheckpointStatus>();
  const [open, setOpen] = useState<string>();
  const [diff, setDiff] = useState<CheckpointFileDiff>();
  const [expanded, setExpanded] = useState(false);
  const load = useCallback(
    () => workspace<CheckpointStatus>("session_checkpoint_status", { sessionId }).then(setStatus, () => setStatus(undefined)),
    [sessionId],
  );
  useEffect(() => {
    void load();
  }, [load, revision]);
  useEffect(() => {
    setDiff(undefined);
    if (open) void workspace<CheckpointFileDiff>("session_checkpoint_file_diff", { sessionId, relative: open }).then(setDiff, () => undefined);
  }, [open, sessionId]);
  const act = (command: "session_checkpoint_undo" | "session_checkpoint_keep", relative: string | null) =>
    void workspace(command, { sessionId, relative }).then(load, () => undefined);
  const files = status?.files ?? [];
  if (!files.length) return null;
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return (
    <div className="card review">
      <div className="review-head">
        <button className="row-button" onClick={() => setExpanded(!expanded)}>
          <span>{files.length === 1 ? "1 file" : `${files.length} files`}</span>
          <span className="add">+{additions}</span>
          <span className="del">−{deletions}</span>
        </button>
        <span className="review-actions">
          <button className="link" onClick={() => act("session_checkpoint_undo", null)} disabled={!files.every((file) => file.undoable)}>
            Undo all
          </button>
          <button className="link" onClick={() => act("session_checkpoint_keep", null)}>Keep all</button>
        </span>
      </div>
      {expanded
        ? files.map((file: CheckpointFile) => (
            <div key={file.relative}>
              <FileRow
                relative={file.relative}
                status={file.status}
                additions={file.additions}
                deletions={file.deletions}
                open={open === file.relative}
                onToggle={() => setOpen(open === file.relative ? undefined : file.relative)}
                actions={
                  <>
                    <button className="link" disabled={!file.undoable} onClick={() => act("session_checkpoint_undo", file.relative)}>Undo</button>
                    <button className="link" onClick={() => act("session_checkpoint_keep", file.relative)}>Keep</button>
                  </>
                }
              />
              {open === file.relative && diff ? <DiffView {...diff} /> : null}
            </div>
          ))
        : null}
    </div>
  );
}

/** The project's uncommitted changes: diffs, staging, commit and push. */
export function ChangesPanel({ cwd, onClose, onError }: { cwd: string; onClose: () => void; onError: (error: unknown) => void }) {
  const [index, setIndex] = useState<GitDiffIndex>();
  const [open, setOpen] = useState<{ relative: string; staged: boolean }>();
  const [diff, setDiff] = useState<CheckpointFileDiff>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(() => workspace<GitDiffIndex>("git_diff_index", { cwd }).then(setIndex, onError), [cwd, onError]);
  usePoll(load, 4000, [cwd]);
  useEffect(() => {
    setDiff(undefined);
    if (open) void workspace<CheckpointFileDiff>("git_file_diff", { cwd, relative: open.relative, staged: open.staged }).then(setDiff, onError);
  }, [open, cwd, onError, index?.head]);
  const act = async (label: string, command: string, args: Record<string, unknown> = {}) => {
    setBusy(label);
    try {
      await workspace(command, { cwd, ...args });
      await load();
    } catch (error) {
      onError(error);
    } finally {
      setBusy("");
    }
  };
  const staged = index?.files.filter((file) => file.staged) ?? [];
  const unstaged = index?.files.filter((file) => file.unstaged || !file.staged) ?? [];
  const section = (title: string, files: GitDiffIndex["files"], isStaged: boolean) =>
    files.length ? (
      <>
        <div className="section-label panel-label">
          {title} <span className="count">{files.length}</span>
          <button className="link" onClick={() => void act(title, isStaged ? "git_unstage_all" : "git_stage_all")}>
            {isStaged ? "Unstage all" : "Stage all"}
          </button>
        </div>
        {files.map((file) => {
          const isOpen = open?.relative === file.relative && open.staged === isStaged;
          return (
            <div key={`${isStaged}-${file.relative}`}>
              <FileRow
                relative={file.relative}
                status={file.status}
                additions={file.additions}
                deletions={file.deletions}
                open={isOpen}
                onToggle={() => setOpen(isOpen ? undefined : { relative: file.relative, staged: isStaged })}
                actions={
                  isStaged ? (
                    <button className="link" onClick={() => void act("unstage", "git_unstage_file", { relative: file.relative })}>Unstage</button>
                  ) : (
                    <>
                      <button
                        className="link"
                        onClick={() => {
                          if (confirm(`Discard the changes to ${file.relative}?`)) void act("discard", "git_discard_file", { relative: file.relative });
                        }}
                      >
                        Discard
                      </button>
                      <button className="link" onClick={() => void act("stage", "git_stage_file", { relative: file.relative })}>Stage</button>
                    </>
                  )
                }
              />
              {isOpen && diff ? <DiffView {...diff} /> : null}
            </div>
          );
        })}
      </>
    ) : null;
  return (
    <aside className="panel">
      <header className="panel-head">
        <span className="panel-title">Changes</span>
        {index ? (
          <>
            <span className="add">+{index.additions}</span>
            <span className="del">−{index.deletions}</span>
          </>
        ) : null}
        <span className="muted mono ellipsis panel-branch">{index?.branch ?? ""}</span>
        <button className="icon" aria-label="Close" onClick={onClose}>
          <svg className="glyph" viewBox="0 0 16 16" aria-hidden><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </header>
      <div className="panel-commit">
        <textarea
          rows={2}
          placeholder={staged.length ? "Commit message" : "Stage changes to commit"}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        <div className="panel-buttons">
          <button
            className="btn"
            disabled={!staged.length || !!busy}
            onClick={async () => {
              setBusy("generate");
              try {
                setMessage(await workspace<string>("generate_commit_message", { cwd, paths: null }));
              } catch (error) {
                onError(error);
              } finally {
                setBusy("");
              }
            }}
          >
            {busy === "generate" ? "Writing…" : "Write message"}
          </button>
          <button
            className="btn primary"
            disabled={!staged.length || !message.trim() || !!busy}
            onClick={() => void act("commit", "git_commit", { message, amend: false }).then(() => setMessage(""))}
          >
            Commit
          </button>
          {index?.remote && (index.ahead || (!index.upstream && index.branch && index.head)) ? (
            <button className="btn" disabled={!!busy} onClick={() => void act("push", "git_push")}>
              {busy === "push" ? "Pushing…" : `Push${index.ahead ? ` ${index.ahead}` : ""}`}
            </button>
          ) : null}
        </div>
      </div>
      <div className="panel-body">
        {index && !index.files.length ? <p className="muted empty-line">No uncommitted changes.</p> : null}
        {section("Staged", staged, true)}
        {section("Changes", unstaged, false)}
      </div>
    </aside>
  );
}

/** Browses the host's folders to open one as a project. */
export function FolderBrowser({ onOpen, onClose, onError }: { onOpen: (cwd: string) => void; onClose: () => void; onError: (error: unknown) => void }) {
  const [directory, setDirectory] = useState<HostDirectory>();
  const [path, setPath] = useState<string>();
  useEffect(() => {
    rpc<HostDirectory>("projects.browse", path ? { path } : {}).then(setDirectory, onError);
  }, [path, onError]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header className="panel-head">
          <span className="panel-title">Open folder</span>
          <button className="icon" aria-label="Close" onClick={onClose}>
            <svg className="glyph" viewBox="0 0 16 16" aria-hidden><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
        </header>
        <div className="browser-path mono ellipsis">{directory ? tilde(directory.path) : "…"}</div>
        <div className="browser-list">
          {directory?.parent ? (
            <button className="browser-entry" onClick={() => setPath(directory.parent!)}>..</button>
          ) : null}
          {directory?.entries.map((entry) => (
            <button key={entry.path} className="browser-entry" onClick={() => setPath(entry.path)}>
              <svg className="glyph" viewBox="0 0 16 16" aria-hidden><path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
              <span className="ellipsis">{entry.name}</span>
            </button>
          ))}
        </div>
        <div className="panel-buttons modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!directory} onClick={() => directory && onOpen(directory.path)}>
            Open {directory ? directory.path.split("/").pop() : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
