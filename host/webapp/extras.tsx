import { useEffect, useState } from "react";
import { Streamdown } from "streamdown";
import type { HostProject, RemoteProvider } from "../../src/features/connections/model/protocol";
import type { Automation } from "../../src/features/automations/model/automations";
import { HarnessIcon } from "../../src/features/sessions/ui/HarnessIcon";
import { command, rpc } from "./api";
import { ago, go, tilde } from "./ui";

type Entry = { name: string; path: string; isDir: boolean; ignored: boolean };

const Close = ({ onClick }: { onClick: () => void }) => (
  <button className="icon" aria-label="Close" onClick={onClick}>
    <svg className="glyph" viewBox="0 0 16 16" aria-hidden><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
  </button>
);

/** Read-only explorer of the project's files, with a viewer. */
export function FilesPanel({ projectId, cwd, onClose, onError }: { projectId: string; cwd?: string; onClose: () => void; onError: (error: unknown) => void }) {
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<Entry[]>();
  const [file, setFile] = useState<{ path: string; text?: string; error?: string }>();
  const [query, setQuery] = useState("");
  useEffect(() => {
    setEntries(undefined);
    const request = query.trim()
      ? rpc<Entry[]>("files.search", { projectId, cwd, query: query.trim() })
      : rpc<Entry[]>("files.list", { projectId, cwd, path: dir });
    request.then(
      (list) => setEntries([...list].sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))),
      onError,
    );
  }, [projectId, cwd, dir, query, onError]);
  const open = (path: string) => {
    setFile({ path });
    rpc<string>("files.read", { projectId, cwd, path }).then(
      (text) => setFile({ path, text }),
      (error) => setFile({ path, error: error instanceof Error ? error.message : String(error) }),
    );
  };
  if (file)
    return (
      <aside className="panel">
        <header className="panel-head">
          <button className="icon" aria-label="Back" onClick={() => setFile(undefined)}>
            <svg className="glyph" viewBox="0 0 16 16" aria-hidden><path d="M10 4L6 8l4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <span className="panel-title ellipsis mono file-title">{file.path}</span>
          <Close onClick={onClose} />
        </header>
        <div className="panel-body code-view">
          {file.error ? <p className="error empty-line">{file.error}</p> : file.text === undefined ? <p className="muted empty-line">Loading…</p> : (
            file.path.endsWith(".md") ? (
              <div className="prose file-markdown"><Streamdown className="md" controls={false} linkSafety={{ enabled: false }}>{file.text}</Streamdown></div>
            ) : (
              <pre>
                {file.text.split("\n").map((line, index) => (
                  <div key={index} className="code-line">
                    <span className="diff-num">{index + 1}</span>
                    <span>{line}</span>
                  </div>
                ))}
              </pre>
            )
          )}
        </div>
      </aside>
    );
  return (
    <aside className="panel">
      <header className="panel-head">
        <span className="panel-title">Files</span>
        <span className="muted mono ellipsis panel-branch">{dir || (cwd ? tilde(cwd) : "")}</span>
        <Close onClick={onClose} />
      </header>
      <input className="search" placeholder="Find a file" value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="panel-body">
        {dir && !query ? (
          <button className="browser-entry" onClick={() => setDir(dir.split("/").slice(0, -1).join("/"))}>..</button>
        ) : null}
        {entries?.map((entry) => (
          <button
            key={entry.path}
            className={`browser-entry${entry.ignored ? " ignored" : ""}`}
            onClick={() => (entry.isDir ? (setQuery(""), setDir(entry.path)) : open(entry.path))}
          >
            {entry.isDir ? (
              <svg className="glyph" viewBox="0 0 16 16" aria-hidden><path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
            ) : (
              <svg className="glyph" viewBox="0 0 16 16" aria-hidden><path d="M4 2.5h5l3 3v8H4z M9 2.5v3h3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>
            )}
            <span className="ellipsis">{query ? entry.path : entry.name}</span>
          </button>
        ))}
        {entries && !entries.length ? <p className="muted empty-line">Nothing here.</p> : null}
      </div>
    </aside>
  );
}

const schedule = (automation: Automation) =>
  automation.triggerKind !== "time"
    ? `On ${automation.triggerKind} · ${automation.triggerEvent}`
    : automation.scheduleKind === "hourly"
      ? `Every hour at :${String(automation.minute).padStart(2, "0")}`
      : automation.scheduleKind === "weekly"
        ? `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][automation.dayOfWeek]} at ${automation.time}`
        : automation.scheduleKind === "weekdays"
          ? `Weekdays at ${automation.time}`
          : `Every day at ${automation.time}`;

/** The automations kept on the host. "Run now" starts the run as a session
 * here, with the automation's prompt, agent and model. */
export function AutomationsPage({ onError }: { onError: (error: unknown) => void }) {
  const [list, setList] = useState<Automation[]>();
  const [starting, setStarting] = useState("");
  useEffect(() => {
    rpc<Automation[]>("automations.list").then(setList, onError);
  }, [onError]);
  const runNow = async (automation: Automation) => {
    setStarting(automation.id);
    try {
      const project = await rpc<HostProject>("projects.open", { cwd: automation.cwd });
      const receipt = await command({
        type: "create",
        projectId: project.id,
        ...(automation.worktreeCwd ? { worktreeCwd: automation.worktreeCwd } : {}),
        harness: automation.harness as RemoteProvider,
        model: automation.model,
        ...(automation.modelSettings ? { modelSettings: automation.modelSettings } : {}),
        runtimeMode: automation.runtimeMode,
      });
      await command({ type: "send", sessionId: receipt.sessionId, text: automation.prompt });
      go({ kind: "session", projectId: project.id, sessionId: receipt.sessionId });
    } catch (error) {
      onError(error);
    } finally {
      setStarting("");
    }
  };
  return (
    <div className="page">
      <div className="page-head"><span className="page-title">Automations</span></div>
      <div className="page-body list">
        {list === undefined ? <p className="muted empty-line">Loading…</p> : null}
        {list && !list.length ? <p className="muted empty-line">No automations on this host.</p> : null}
        {list?.map((automation) => (
          <div key={automation.id} className={`session automation${automation.enabled ? "" : " archived"}`}>
            <span className="session-line meta">
              <HarnessIcon harness={automation.harness} className="harness" />
              <span className="ellipsis">{schedule(automation)}</span>
              <span className="time">{automation.lastRunAt ? `ran ${ago(automation.lastRunAt)} ago` : "never ran"}</span>
            </span>
            <span className="session-line">
              <span className="session-title ellipsis">{automation.name}</span>
              {automation.lastRunStatus === "failed" ? <span className="pill red">Failed</span> : null}
              <button className="btn" disabled={!!starting} onClick={() => void runNow(automation)}>
                {starting === automation.id ? "Starting…" : "Run now"}
              </button>
            </span>
            <span className="session-line meta"><span className="ellipsis">{tilde(automation.cwd)} · {automation.prompt}</span></span>
          </div>
        ))}
      </div>
    </div>
  );
}
