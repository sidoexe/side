import { useEffect, useState } from "react";
import { Streamdown } from "streamdown";
import type { HostProject, RemoteProvider } from "../../src/features/connections/model/protocol";
import type { Automation } from "../../src/features/automations/model/automations";
import type { Mono } from "../../src/features/monos/model/mono";
import type { Block } from "../../src/features/sessions/model/session";
import { HarnessIcon } from "../../src/features/sessions/ui/HarnessIcon";
import { monoReactionBlocks } from "../../src/features/monos/model/monoReaction";
import { command, rpc } from "./api";
import { ProjectBackground } from "./rail";
import { Transcript } from "./Transcript";
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

const monoName = (mono: Mono) => mono.name || mono.mascot.charAt(0).toUpperCase() + mono.mascot.slice(1);

type InboxMessage = { id: string; text: string; account?: string; at: number; takenBy?: string };

/** How often an open colleague's chat is read again while it may change. */
const CHAT_POLL_MS = 2_500;
/** After this, a message no desktop took says so. */
const UNTAKEN_MS = 10_000;

/** Colleagues kept on the host: who they are, what they remember, and their
 * conversation. Their chats run on a desktop: a message written here waits on
 * the host until an open desktop takes it and sends it, and the reply shows
 * here as that desktop saves the chat. */
export function ColleaguesPage({
  canWrite,
  onError,
}: {
  /** The host keeps messages for desktops to send. */
  canWrite: boolean;
  onError: (error: unknown) => void;
}) {
  const [roster, setRoster] = useState<Mono[]>();
  const [openId, setOpenId] = useState<string>();
  const [files, setFiles] = useState<{ soul: string | null; memory: string }>();
  const [chat, setChat] = useState<Block[]>();
  const [inbox, setInbox] = useState<InboxMessage[]>([]);
  const [tab, setTab] = useState<"chat" | "memory" | "soul">("chat");
  const [backgrounds, setBackgrounds] = useState<Record<string, { updatedAt: number; mimeType?: string }>>({});
  const [now, setNow] = useState(Date.now());
  const open = roster?.find((mono) => mono.id === openId);
  useEffect(() => {
    rpc<{ roster: Mono[] }>("employees.roster").then((value) => setRoster(value.roster), onError);
    // Older hosts keep no backgrounds: the page shows without them.
    rpc<typeof backgrounds>("employees.backgrounds").then(setBackgrounds, () => undefined);
  }, [onError]);
  useEffect(() => {
    setFiles(undefined);
    setChat(undefined);
    setInbox([]);
    if (!openId) return;
    rpc<{ soul: string | null; memory: string }>("employees.load", { mono: openId }).then(setFiles, onError);
  }, [openId, onError]);
  const sessionId = open?.sessionId;
  useEffect(() => {
    if (!openId) return;
    let stopped = false;
    const read = async () => {
      // A first message here gives the colleague its chat on the desktop
      // that takes it; the roster then names it.
      const id = sessionId ?? (await rpc<{ roster: Mono[] }>("employees.roster").then((value) => {
        if (!stopped) setRoster(value.roster);
        return value.roster.find((mono) => mono.id === openId)?.sessionId;
      }, () => undefined));
      const [blocks, waiting] = await Promise.all([
        id
          ? rpc<{ blocks: Block[] } | null>("employees.sessionGet", { sessionId: id }).then((value) => value?.blocks ?? [], () => undefined)
          : Promise.resolve([] as Block[]),
        canWrite ? rpc<InboxMessage[]>("employees.inbox", { mono: openId }).catch(() => undefined) : Promise.resolve([]),
      ]);
      if (stopped) return;
      if (blocks) setChat(blocks);
      if (waiting) setInbox(waiting);
      setNow(Date.now());
    };
    void read();
    const timer = setInterval(() => void read(), CHAT_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [openId, sessionId, canWrite]);
  const send = async (text: string) => {
    if (!open) return;
    const message = await rpc<InboxMessage>("employees.post", { mono: open.id, text });
    setInbox((current) => [...current, message]);
  };
  const background = (mono: Mono) => {
    const stamp = backgrounds[mono.id];
    return stamp?.mimeType
      ? `/web/colleague-background?id=${encodeURIComponent(mono.id)}&v=${stamp.updatedAt}`
      : undefined;
  };
  if (open)
    return (
      <div className="colleague-view">
        <ProjectBackground url={background(open)} />
        <div className="page">
          <div className="page-head">
            <button className="link" onClick={() => setOpenId(undefined)}>← Colleagues</button>
            <span className="page-title">{monoName(open)}</span>
          </div>
          <div className="tabs">
            {(["chat", "memory", "soul"] as const).map((name) => (
              <button key={name} className={tab === name ? "on" : ""} onClick={() => setTab(name)}>
                {name === "chat" ? "Conversation" : name === "memory" ? "Memory" : "Soul"}
              </button>
            ))}
          </div>
          <div className="transcript-inner page-body">
            {tab === "chat" ? (
              chat === undefined ? <p className="muted">Loading…</p> : chat.length || inbox.length ? (
                <>
                  <Transcript blocks={monoReactionBlocks(chat)} cwd="" running={false} canDecide={false} onDecide={() => undefined} />
                  {inbox.map((message) => (
                    <div key={message.id} className="colleague-waiting">
                      <div className="colleague-waiting-text">{message.account ? "Switch account" : message.text}</div>
                      <span className="muted">
                        {message.takenBy
                          ? "Sending from a desktop…"
                          : now - message.at > UNTAKEN_MS
                            ? "Waiting for a desktop: open sIDE on one of your computers to send it."
                            : "Waiting for a desktop…"}
                      </span>
                    </div>
                  ))}
                </>
              ) : <p className="muted">No conversation yet.</p>
            ) : (
              <div className="prose">
                <Streamdown className="md" controls={false} linkSafety={{ enabled: false }}>
                  {(tab === "memory" ? files?.memory : files?.soul) || "_Empty._"}
                </Streamdown>
              </div>
            )}
          </div>
        </div>
        {tab === "chat" && canWrite ? (
          <ColleagueComposer name={monoName(open)} onSend={send} />
        ) : null}
      </div>
    );
  return (
    <div className="page">
      <div className="page-head"><span className="page-title">Colleagues</span></div>
      <div className="page-body list">
        {roster === undefined ? <p className="muted empty-line">Loading…</p> : null}
        {roster && !roster.length ? <p className="muted empty-line">No colleagues on this host. They live here when it is your home machine.</p> : null}
        {roster?.map((mono) => (
          <button key={mono.id} className="session" onClick={() => setOpenId(mono.id)}>
            <span className="session-line"><span className="mono-dot" style={{ background: mono.color }} /><span className="session-title">{monoName(mono)}</span></span>
            <span className="session-line meta"><span className="ellipsis">{mono.projects.map((path) => path.split("/").pop()).join(", ") || "No projects"}</span></span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Writing to a colleague: Enter sends, Shift+Enter starts a new line. */
function ColleagueComposer({ name, onSend }: { name: string; onSend: (text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setError("");
    try {
      await onSend(value);
      setText("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          rows={1}
          value={text}
          placeholder={`Message ${name}`}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        {error ? <div className="composer-error">{error}</div> : null}
        <div className="composer-bar">
          <span className="composer-hint">Sent through a desktop that has sIDE open</span>
          <button className="square send" disabled={!text.trim() || sending} onClick={() => void submit()} aria-label="Send">
            <svg className="glyph" viewBox="0 0 16 16" aria-hidden><path d="M8 13V3M4 7l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
      </div>
    </div>
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
