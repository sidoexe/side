import { useEffect, useState, type ReactNode } from "react";
import { readAttachment } from "./api";
import { folderName, type Attachment, type Block } from "./model";
import { Button, CardLabel, Icon, Spinner } from "./ui";

/** One row of the transcript: a block shown on its own, or a run of tool
 * calls, thinking and interim notes folded into a single "Worked" line. */
export type TranscriptItem =
  | { kind: "block"; id: string; block: Block }
  | { kind: "activity"; id: string; blocks: Block[]; worked?: number; live: boolean };

/** Todo edits show as the tasks card, not as calls (`isHiddenTool`). */
const hiddenTool = (block: Block) => block.role === "tool" && block.tool?.kind?.toLowerCase() === "tasks";
const failed = (block: Block) => ["failed", "error", "errored"].includes(block.tool?.status ?? "");
const inFlight = (block: Block) => block.streaming === true || ["in_progress", "pending"].includes(block.tool?.status ?? "");

/** As the web transcript groups a turn: its last assistant message stands
 * alone, everything that led to it folds away. */
export function buildTranscript(blocks: Block[], running: boolean): TranscriptItem[] {
  const turns: Block[][] = [];
  for (const block of blocks) {
    if (block.internal || hiddenTool(block)) continue;
    if (block.role === "user" || block.role === "handoff" || !turns.length) turns.push([]);
    turns[turns.length - 1].push(block);
  }
  const items: TranscriptItem[] = [];
  turns.forEach((turn, index) => {
    const live = running && index === turns.length - 1;
    let final = -1;
    turn.forEach((block, offset) => block.role === "assistant" && (final = offset));
    const worked = turn[0]?.role === "user" ? turn[0].durationMs : undefined;
    let pending: Block[] = [];
    const groups: number[] = [];
    const flush = () => {
      if (!pending.length) return;
      groups.push(items.length);
      items.push({ kind: "activity", id: `activity-${pending[0].id}`, blocks: pending, live });
      pending = [];
    };
    turn.forEach((block, offset) => {
      if (block.role === "reasoning" || block.role === "tool" || (block.role === "assistant" && offset !== final)) pending.push(block);
      else {
        flush();
        items.push({ kind: "block", id: block.id, block });
      }
    });
    flush();
    // Only the turn's last fold says how long the turn took, and only the
    // last one still runs.
    groups.forEach((at, n) => {
      const item = items[at];
      if (item.kind !== "activity") return;
      const last = n === groups.length - 1;
      items[at] = { ...item, worked: last ? worked : undefined, live: live && last && at === items.length - 1 };
    });
  });
  return items;
}

/** As `toolCallLabel`, simplified: the agent's title, else its target. */
function toolLabel(block: Block, cwd: string) {
  const preview = block.tool?.preview;
  const path = preview?.path ? (preview.path.startsWith(`${cwd}/`) ? preview.path.slice(cwd.length + 1) : preview.path) : preview?.fileName;
  const verb = (() => {
    switch ((preview?.kind ?? block.tool?.kind)?.toLowerCase()) {
      case "read":
        return "Read";
      case "write":
      case "edit":
        return "Edit";
      case "search":
        return "Search";
      default:
        return undefined;
    }
  })();
  const title = (block.text || block.tool?.title) ?? "";
  if (title) return path && !title.includes(path) && verb ? `${verb} ${path}` : title;
  if (path) return `${verb ?? "Open"} ${path}`;
  if (preview?.query) return `Search ${preview.query}`;
  return "Working";
}

function category(block: Block) {
  const kind = block.tool?.kind?.toLowerCase() ?? "";
  const preview = block.tool?.preview?.kind;
  if (preview === "write" || ["edit", "write", "delete", "move"].includes(kind) || (block.tool?.preview?.additions ?? 0) + (block.tool?.preview?.deletions ?? 0) > 0)
    return "edit";
  if (preview === "read" || kind === "read") return "read";
  if (preview === "search" || ["search", "fetch"].includes(kind)) return "search";
  if (preview === "shell" || ["execute", "shell", "bash"].includes(kind)) return "run";
  if (kind === "agent" || kind === "task") return "agent";
  return "other";
}

export function TranscriptItemView({
  machineId,
  item,
  cwd,
  sessionId,
  canDecide,
  onDecide,
  editableId,
  onEdit,
  onBuild,
}: {
  machineId: string;
  item: TranscriptItem;
  cwd: string;
  sessionId: string;
  canDecide: boolean;
  onDecide: (requestId: number, decision: "allow" | "deny") => void;
  editableId?: string;
  onEdit?: (block: Block) => void;
  onBuild?: (block: Block) => void;
}) {
  if (item.kind === "activity") return <ActivityView blocks={item.blocks} cwd={cwd} worked={item.worked} live={item.live} />;
  const block = item.block;
  switch (block.role) {
    case "user":
      return (
        <div className={`user-block${block.draft ? " draft" : ""}`}>
          {block.text ? <div className="user-text">{block.text}</div> : null}
          {block.attachments?.length ? (
            <>
              {/* Images show as the desktop shows them; the rest by name. */}
              {block.attachments
                .filter((attachment) => attachment.kind === "image")
                .map((attachment) => (
                  <AttachmentImage key={attachment.id} machineId={machineId} sessionId={sessionId} attachment={attachment} />
                ))}
              <div className="attachment-names">
                {block.attachments
                  .filter((attachment) => attachment.kind !== "image")
                  .map((attachment) => (
                    <span key={attachment.id} className="row-line">
                      <Icon name="doc" size={12} />
                      <span className="ellipsis">{attachment.name}</span>
                    </span>
                  ))}
              </div>
            </>
          ) : null}
          {block.id === editableId && onEdit ? (
            <button className="link-button muted meta" onClick={() => onEdit(block)}>
              Edit
            </button>
          ) : null}
        </div>
      );
    case "assistant":
      return <Markdown text={block.text} />;
    case "approval":
      return <ApprovalCard block={block} canDecide={canDecide} onDecide={onDecide} />;
    case "tasks":
      return (
        <div className="card tasks">
          {(block.taskList?.items ?? []).map((task, index) => {
            const over = task.status === "completed" || task.status === "cancelled";
            return (
              <div key={index} className="task">
                <TaskMark status={task.status} />
                <span className={over ? "muted strike" : ""}>{task.text}</span>
              </div>
            );
          })}
        </div>
      );
    case "plan":
      return (
        <div className="card plan">
          <CardLabel text="Plan" />
          <Markdown text={block.text} />
          {block.plan?.status === "ready" && onBuild ? (
            <div className="button-row end">
              <Button primary onClick={() => onBuild(block)}>
                Build
              </Button>
            </div>
          ) : block.plan?.status === "building" || block.plan?.status === "built" ? (
            <div className="meta muted">{block.plan.status === "built" ? "Built" : "Building…"}</div>
          ) : null}
        </div>
      );
    case "system":
    case "handoff":
      if (!block.text.trim()) return null;
      return block.notice === "error" || block.notice === "interrupt" ? <div className="notice">{block.text}</div> : <div className="system">{block.text}</div>;
    case "image":
      // Kept with the host's attachments: shown as the images sent in.
      if (block.image?.attachmentId && block.image.size)
        return (
          <AttachmentImage
            machineId={machineId}
            sessionId={sessionId}
            attachment={{
              id: block.image.attachmentId,
              name: block.image.alt ?? block.image.name ?? "Generated image",
              mimeType: block.image.mimeType ?? "image/png",
              kind: "image",
              size: block.image.size,
            }}
          />
        );
      // Made before hosts kept them: say that it exists.
      return (
        <div className="system row-line">
          <Icon name="photo" size={14} />
          <span className="clamp-2">{block.image?.alt ?? block.image?.name ?? "Generated image"}</span>
        </div>
      );
    default:
      return null;
  }
}

/** Images read once from the host and kept for the page's life. */
const images = new Map<string, Promise<string>>();

/** An image sent in a session, read from the host once and kept. */
function AttachmentImage({ machineId, sessionId, attachment }: { machineId: string; sessionId: string; attachment: Attachment }) {
  const [url, setUrl] = useState<string>();
  const [failedToLoad, setFailed] = useState(false);
  useEffect(() => {
    const key = `${machineId}/${sessionId}/${attachment.id}`;
    let read = images.get(key);
    if (!read) {
      read = readAttachment(machineId, sessionId, attachment).then((blob) => URL.createObjectURL(blob));
      read.catch(() => images.delete(key));
      images.set(key, read);
    }
    let live = true;
    read.then((value) => live && setUrl(value), () => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [machineId, sessionId, attachment]);
  if (url) return <img className="attachment-image" src={url} alt={attachment.name} />;
  if (failedToLoad)
    return (
      <span className="row-line meta muted">
        <Icon name="photo" size={12} />
        <span className="ellipsis">{attachment.name}</span>
      </span>
    );
  return (
    <div className="image-loading">
      <Spinner size={16} />
    </div>
  );
}

function TaskMark({ status }: { status: string }) {
  return <span className={`task-mark ${status}`} aria-label={status} />;
}

function ApprovalCard({ block, canDecide, onDecide }: { block: Block; canDecide: boolean; onDecide: (requestId: number, decision: "allow" | "deny") => void }) {
  const decided = block.approval?.decided;
  const decide = (decision: "allow" | "deny") => {
    navigator.vibrate?.(12);
    onDecide(block.approval!.requestId, decision);
  };
  return (
    <div className="approval">
      <div className="approval-title">{block.tool?.title ?? (block.text || "Permission requested")}</div>
      {block.tool?.detail ? <CodeBox text={block.tool.detail} maxHeight={220} /> : null}
      {decided ? (
        <div className="meta muted">{decided === "allow" ? "Allowed" : decided === "deny" ? "Denied" : "Cancelled"}</div>
      ) : canDecide && block.approval ? (
        <div className="button-row end">
          <Button onClick={() => decide("deny")}>Deny</Button>
          <Button primary onClick={() => decide("allow")}>
            Allow
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Monospaced output in a faint box that scrolls both ways. */
function CodeBox({ text, maxHeight = 260 }: { text: string; maxHeight?: number }) {
  return (
    <pre className="code-box" style={{ maxHeight }}>
      {text.length > 20_000 ? `${text.slice(0, 20_000)}\n…` : text}
    </pre>
  );
}

function Chevron({ open }: { open: boolean }) {
  return <Icon name="chevronRight" size={10} className={`faint chevron${open ? " open" : ""}`} />;
}

function duration(ms: number) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** As `workSummaryLine`: what the calls add up to. */
function workSummary(blocks: Block[], worked: number | undefined, live: boolean) {
  if (worked !== undefined && !live) return `Worked for ${duration(worked)}`;
  const tools = blocks.filter((block) => block.role === "tool");
  if (!tools.length) return live ? "Thinking" : "Thought";
  const order: string[] = [];
  const edits = new Set<string>();
  const reads = new Set<string>();
  let runs = 0;
  let agents = 0;
  let others = 0;
  for (const block of tools) {
    const kind = category(block);
    if (!order.includes(kind)) order.push(kind);
    const target = block.tool?.preview?.path ?? block.tool?.preview?.fileName ?? block.id;
    if (kind === "edit") edits.add(target);
    else if (kind === "read") reads.add(target);
    else if (kind === "run") runs += 1;
    else if (kind === "agent") agents += 1;
    else if (kind !== "search") others += 1;
  }
  const current = live ? category(tools[tools.length - 1]) : undefined;
  const files = (set: Set<string>) => (set.size === 1 ? folderName([...set][0]) : `${set.size} files`);
  return order
    .map((kind) => {
      const now = kind === current;
      switch (kind) {
        case "edit":
          return `${now ? "Editing" : "Edited"} ${files(edits)}`;
        case "read":
          return `${now ? "Reading" : "Read"} ${files(reads)}`;
        case "search":
          return now ? "Searching the project" : "Searched the project";
        case "run":
          return runs === 1 ? (now ? "Running a command" : "Ran a command") : `${now ? "Running" : "Ran"} ${runs} commands`;
        case "agent":
          return agents === 1 ? (now ? "Running a subagent" : "Ran a subagent") : `Ran ${agents} subagents`;
        default:
          return others === 1 ? "1 step" : `${others} steps`;
      }
    })
    .join(" · ");
}

function ActivityView({ blocks, cwd, worked, live }: { blocks: Block[]; cwd: string; worked?: number; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="activity">
      <button className="activity-summary" onClick={() => setOpen(!open)}>
        {worked !== undefined && !live ? <Icon name="check" size={12} /> : null}
        <span className={`ellipsis${live ? " shimmer" : ""}`}>{workSummary(blocks, worked, live)}</span>
        <Chevron open={open} />
      </button>
      {open ? (
        <div className="activity-body">
          {blocks.map((block) =>
            block.role === "tool" ? (
              <ToolRow key={block.id} block={block} cwd={cwd} />
            ) : (block.role === "reasoning" || block.role === "assistant") && block.text.trim() ? (
              <Markdown key={block.id} text={block.text} small />
            ) : null,
          )}
        </div>
      ) : null}
    </div>
  );
}

function ToolRow({ block, cwd }: { block: Block; cwd: string }) {
  const [open, setOpen] = useState(false);
  const preview = block.tool?.preview;
  const output = preview?.output ?? block.tool?.detail ?? "";
  const diff = !!preview?.lines?.length && (preview.additions ?? 0) + (preview.deletions ?? 0) > 0;
  return (
    <div className="tool">
      <button className="tool-row" disabled={!diff && !output} onClick={() => setOpen(!open)}>
        <span className={`tool-label ellipsis${failed(block) ? " del" : ""}${inFlight(block) ? " shimmer" : ""}`}>{toolLabel(block, cwd)}</span>
        {preview?.additions ? <span className="add">+{preview.additions}</span> : null}
        {preview?.deletions ? <span className="del">−{preview.deletions}</span> : null}
      </button>
      {open ? diff ? <DiffCard block={block} cwd={cwd} /> : output ? <CodeBox text={output} /> : null : null}
    </div>
  );
}

function DiffCard({ block, cwd }: { block: Block; cwd: string }) {
  const preview = block.tool?.preview;
  return (
    <div className="diff">
      <div className="diff-head">
        <span className="ellipsis rtl"><bdi>{preview?.path?.replace(`${cwd}/`, "") ?? preview?.fileName ?? ""}</bdi></span>
        <span className="spacer" />
        {preview?.additions ? <span className="add">+{preview.additions}</span> : null}
        {preview?.deletions ? <span className="del">−{preview.deletions}</span> : null}
      </div>
      <div className="diff-lines">
        {(preview?.lines ?? []).slice(0, 60).map((line, index) => (
          <div key={index} className={`diff-line ${line.kind}`}>
            <span className="diff-number">{line.number ?? ""}</span>
            <span className="diff-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
            <span className="diff-text">{line.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// MARK: Markdown

type Part =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "item"; marker: string; indent: number; text: string }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string }
  | { kind: "table"; rows: string[] }
  | { kind: "rule" };

function parse(text: string): Part[] {
  const parts: Part[] = [];
  let paragraph: string[] = [];
  let code: string[] | undefined;
  let table: string[] = [];
  const flush = () => {
    if (paragraph.length) parts.push({ kind: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
    if (table.length) parts.push({ kind: "table", rows: table });
    table = [];
  };
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      if (code) {
        parts.push({ kind: "code", text: code.join("\n") });
        code = undefined;
      } else {
        flush();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    let match: RegExpMatchArray | null;
    if (!trimmed) flush();
    else if (trimmed.startsWith("|")) {
      if (paragraph.length) {
        parts.push({ kind: "paragraph", text: paragraph.join("\n") });
        paragraph = [];
      }
      if (!/^\|[\s:|-]+\|?$/.test(trimmed)) table.push(trimmed);
    } else if ((match = trimmed.match(/^(#{1,6})\s+(.*)$/))) {
      flush();
      parts.push({ kind: "heading", level: match[1].length, text: match[2] });
    } else if (/^([-*_])\s*(\1\s*){2,}$/.test(trimmed)) {
      flush();
      parts.push({ kind: "rule" });
    } else if ((match = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/))) {
      flush();
      parts.push({ kind: "item", marker: /\d/.test(match[2][0]) ? match[2] : "•", indent: Math.floor(match[1].length / 2), text: match[3] });
    } else if (trimmed.startsWith(">")) {
      flush();
      parts.push({ kind: "quote", text: trimmed.replace(/^[>\s]+/, "") });
    } else paragraph.push(line);
  }
  if (code) parts.push({ kind: "code", text: code.join("\n") });
  flush();
  return parts;
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

/** Inline Markdown: code, bold, italics, strikethrough and links. */
function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) nodes.push(text.slice(last, at));
    const [token, code, bold, italic, strike, link, url] = match;
    const key = nodes.length;
    if (code) nodes.push(<code key={key}>{code.slice(1, -1)}</code>);
    else if (bold) nodes.push(<strong key={key}>{inline(bold.slice(2, -2))}</strong>);
    else if (italic) nodes.push(<em key={key}>{inline(italic.slice(1, -1))}</em>);
    else if (strike) nodes.push(<s key={key}>{inline(strike.slice(2, -2))}</s>);
    else if (link) {
      const [, label, href] = link.match(/^\[([^\]]+)\]\(([^)]+)\)$/) ?? [];
      nodes.push(
        /^https?:\/\//.test(href ?? "") ? (
          <a key={key} href={href} target="_blank" rel="noreferrer noopener">
            {inline(label)}
          </a>
        ) : (
          <span key={key} className="link">
            {inline(label)}
          </span>
        ),
      );
    } else if (url)
      nodes.push(
        <a key={key} href={url} target="_blank" rel="noreferrer noopener">
          {url}
        </a>,
      );
    else nodes.push(token);
    last = at + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

/** Agent replies as the desktop renders Markdown: headings, lists, quotes,
 * tables and fenced code, inline code and links. */
export function Markdown({ text, small }: { text: string; small?: boolean }) {
  return (
    <div className={`markdown${small ? " small muted" : ""}`}>
      {parse(text).map((part, index) => {
        switch (part.kind) {
          case "paragraph":
            return <p key={index}>{inline(part.text)}</p>;
          case "heading":
            return (
              <p key={index} className="md-heading">
                {inline(part.text)}
              </p>
            );
          case "item":
            return (
              <div key={index} className="md-item" style={{ paddingLeft: part.indent * 16 }}>
                <span className="md-marker">{part.marker}</span>
                <span>{inline(part.text)}</span>
              </div>
            );
          case "quote":
            return (
              <blockquote key={index} className="md-quote">
                {inline(part.text)}
              </blockquote>
            );
          case "code":
            return (
              <pre key={index} className="md-code">
                {part.text}
              </pre>
            );
          case "table":
            return (
              <div key={index} className="md-table-scroll">
                <table className="md-table">
                  <tbody>
                    {part.rows.map((row, rowIndex) => (
                      <tr key={rowIndex} className={rowIndex === 0 ? "head" : ""}>
                        {cells(row).map((cell, column) => (
                          <td key={column}>{inline(cell)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "rule":
            return <hr key={index} className="md-rule" />;
        }
      })}
    </div>
  );
}
