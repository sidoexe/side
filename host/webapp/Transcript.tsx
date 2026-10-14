import { memo, useState } from "react";
import { Streamdown } from "streamdown";
import type { Block } from "../../src/features/sessions/model/session";
import {
  groupTurnItems,
  groupTurns,
  isFailedStatus,
  toolCallLabel,
  workSummaryLine,
} from "../../src/features/sessions/model/transcriptActivity";

const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <Streamdown className="md" controls={false} linkSafety={{ enabled: false }} isAnimating={!!streaming}>
      {text}
    </Streamdown>
  );
});

const duration = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

const Chevron = ({ open }: { open: boolean }) => (
  <svg className={`chevron${open ? " open" : ""}`} viewBox="0 0 16 16" aria-hidden>
    <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const Check = () => (
  <svg className="glyph" viewBox="0 0 16 16" aria-hidden>
    <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function Diff({ block, cwd }: { block: Block; cwd: string }) {
  const preview = block.tool!.preview!;
  return (
    <div className="diff-card">
      <div className="diff-head">
        <span className="diff-file">{preview.path ? preview.path.replace(`${cwd}/`, "") : preview.fileName}</span>
        {preview.additions ? <span className="add">+{preview.additions}</span> : null}
        {preview.deletions ? <span className="del">−{preview.deletions}</span> : null}
      </div>
      <div className="diff-body">
        {preview.lines!.slice(0, 40).map((line, index) => (
          <div key={index} className={`diff-line ${line.kind}`}>
            <span className="diff-num">{line.number ?? ""}</span>
            <span className="diff-mark">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
            <span className="diff-text">{line.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Tool({ block, cwd }: { block: Block; cwd: string }) {
  const [open, setOpen] = useState(false);
  const tool = block.tool ?? {};
  const preview = tool.preview;
  const output = preview?.output || tool.detail || "";
  const failed = isFailedStatus(tool.status);
  const running = !!block.streaming || tool.status === "in_progress" || tool.status === "pending";
  const diff = preview?.lines?.length && (preview.additions || preview.deletions);
  return (
    <div className="tool">
      <button className="row-button" onClick={() => setOpen(!open)} disabled={!diff && !output}>
        <span className={`tool-label${failed ? " failed" : ""}${running ? " shimmer" : ""}`}>{toolCallLabel(block, cwd)}</span>
        {preview?.additions ? <span className="add">+{preview.additions}</span> : null}
        {preview?.deletions ? <span className="del">−{preview.deletions}</span> : null}
      </button>
      {open && diff ? <Diff block={block} cwd={cwd} /> : null}
      {open && !diff && output ? <pre className="tool-output">{output}</pre> : null}
    </div>
  );
}

function Activity({ blocks, cwd, live, worked }: { blocks: Block[]; cwd: string; live: boolean; worked?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="activity">
      <button className="row-button activity-head" onClick={() => setOpen(!open)}>
        {worked !== undefined && !live ? <Check /> : null}
        <span className={live ? "shimmer" : ""}>
          {worked !== undefined && !live ? `Worked for ${duration(worked)}` : workSummaryLine(blocks, live)}
        </span>
        <Chevron open={open} />
      </button>
      {open ? (
        <div className="activity-body">
          {blocks.map((block) =>
            block.role === "reasoning" ? (
              block.text.trim() ? <div key={block.id} className="thinking"><Markdown text={block.text} /></div> : null
            ) : block.role === "tool" ? (
              <Tool key={block.id} block={block} cwd={cwd} />
            ) : block.role === "assistant" ? (
              <div key={block.id} className="note"><Markdown text={block.text} /></div>
            ) : null,
          )}
        </div>
      ) : null}
    </div>
  );
}

function Item({
  block,
  canDecide,
  onDecide,
}: {
  block: Block;
  canDecide: boolean;
  onDecide: (requestId: number, decision: "allow" | "deny") => void;
}) {
  switch (block.role) {
    case "user":
      return (
        <div className={`user-message${block.draft ? " draft" : ""}`}>
          {block.text}
          {block.attachments?.length ? (
            <div className="attachments">{block.attachments.map((a) => a.name).join(", ")}</div>
          ) : null}
        </div>
      );
    case "assistant":
      return <div className="prose"><Markdown text={block.text} streaming={block.streaming} /></div>;
    case "approval": {
      const decided = block.approval?.decided;
      return (
        <div className="card approval">
          <div className="card-title">{block.tool?.title || block.text || "Permission requested"}</div>
          {block.tool?.detail ? <pre className="tool-output">{block.tool.detail}</pre> : null}
          {decided ? (
            <div className="muted">{decided === "allow" ? "Allowed" : decided === "deny" ? "Denied" : "Cancelled"}</div>
          ) : canDecide && block.approval ? (
            <div className="actions">
              <button className="btn" onClick={() => onDecide(block.approval!.requestId, "deny")}>Deny</button>
              <button className="btn primary" onClick={() => onDecide(block.approval!.requestId, "allow")}>Allow</button>
            </div>
          ) : null}
        </div>
      );
    }
    case "tasks":
      return (
        <div className="card tasks">
          {block.taskList?.items.map((item, index) => (
            <div key={item.id ?? index} className={`task ${item.status}`}>
              <span className="task-mark" />
              {item.text}
            </div>
          ))}
        </div>
      );
    case "plan":
      return (
        <div className="card plan">
          <div className="card-label">Plan</div>
          <Markdown text={block.text} streaming={block.streaming} />
        </div>
      );
    case "system":
    case "handoff":
      return block.text.trim() ? <div className={`system${block.notice ? ` ${block.notice}` : ""}`}>{block.text}</div> : null;
    default:
      return null;
  }
}

export function Transcript({
  blocks,
  cwd,
  running,
  canDecide,
  onDecide,
}: {
  blocks: Block[];
  cwd: string;
  running: boolean;
  canDecide: boolean;
  onDecide: (requestId: number, decision: "allow" | "deny") => void;
}) {
  const turns = groupTurns(blocks);
  return (
    <>
      {turns.map((turn, turnIndex) => {
        const live = running && turnIndex === turns.length - 1;
        const items = groupTurnItems(turn, { settled: !live });
        const lastActivity = items.map((item) => item.type).lastIndexOf("activity");
        const worked = turn[0]?.role === "user" ? turn[0].durationMs : undefined;
        return (
          <div key={turn[0]?.id ?? turnIndex} className="turn">
            {items.map((item, index) =>
              item.type === "block" ? (
                <Item key={item.block.id} block={item.block} canDecide={canDecide} onDecide={onDecide} />
              ) : (
                <Activity
                  key={item.blocks[0].id}
                  blocks={item.blocks}
                  cwd={cwd}
                  live={live && index === items.length - 1}
                  worked={index === lastActivity ? worked : undefined}
                />
              ),
            )}
          </div>
        );
      })}
    </>
  );
}
