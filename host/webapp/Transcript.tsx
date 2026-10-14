import { memo, useState } from "react";
import { Streamdown } from "streamdown";
import type { Block } from "../../src/features/sessions/model/session";

const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <Streamdown className="md" controls={false} linkSafety={{ enabled: false }} isAnimating={!!streaming}>
      {text}
    </Streamdown>
  );
});

function Tool({ block }: { block: Block }) {
  const [open, setOpen] = useState(false);
  const tool = block.tool ?? {};
  const preview = tool.preview;
  const title = tool.title || preview?.title || block.text || tool.kind || "Tool";
  const detail =
    preview?.lines?.map((line) => (line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  ") + line.text).join("\n") ||
    preview?.output ||
    tool.detail ||
    "";
  const failed = tool.status === "failed" || tool.status === "error";
  const running = block.streaming || tool.status === "in_progress" || tool.status === "running" || tool.status === "pending";
  return (
    <div className={`tool${failed ? " failed" : ""}`}>
      <button className="tool-head" onClick={() => detail && setOpen(!open)} disabled={!detail}>
        <span className={`dot${running ? " running" : ""}`} />
        <span className="tool-title">{title}</span>
        {preview?.additions || preview?.deletions ? (
          <span className="tool-diff">
            <span className="add">+{preview.additions ?? 0}</span> <span className="del">−{preview.deletions ?? 0}</span>
          </span>
        ) : null}
        {detail ? <span className="chev">{open ? "▾" : "▸"}</span> : null}
      </button>
      {open ? <pre className="tool-detail">{detail}</pre> : null}
      {block.agentRun?.steps?.length ? (
        <div className="agent-steps">
          {block.agentRun.steps.slice(-4).map((step) => (
            <div key={step.id} className="agent-step">{step.text}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Reasoning({ block }: { block: Block }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="reasoning">
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className={`dot${block.streaming ? " running" : ""}`} />
        <span className="tool-title">Thinking</span>
        <span className="chev">{open ? "▾" : "▸"}</span>
      </button>
      {open ? <div className="reasoning-body"><Markdown text={block.text} /></div> : null}
    </div>
  );
}

export function Transcript({
  blocks,
  canDecide,
  onDecide,
}: {
  blocks: Block[];
  canDecide: boolean;
  onDecide: (requestId: number, decision: "allow" | "deny") => void;
}) {
  return (
    <>
      {blocks.map((block) => {
        if (block.internal) return null;
        switch (block.role) {
          case "user":
            return (
              <div key={block.id} className={`user${block.draft ? " draft" : ""}`}>
                <div className="bubble">
                  {block.text}
                  {block.attachments?.length ? (
                    <div className="attachments">{block.attachments.map((a) => a.name).join(", ")}</div>
                  ) : null}
                </div>
              </div>
            );
          case "assistant":
            return (
              <div key={block.id} className="assistant">
                <Markdown text={block.text} streaming={block.streaming} />
              </div>
            );
          case "reasoning":
            return block.text.trim() ? <Reasoning key={block.id} block={block} /> : null;
          case "tool":
            return <Tool key={block.id} block={block} />;
          case "approval": {
            const decided = block.approval?.decided;
            return (
              <div key={block.id} className="approval">
                <div className="approval-text">{block.tool?.title || block.text || "Permission requested"}</div>
                {block.tool?.detail ? <pre className="tool-detail">{block.tool.detail}</pre> : null}
                {decided ? (
                  <div className={`decided ${decided}`}>{decided === "allow" ? "Allowed" : decided === "deny" ? "Denied" : "Cancelled"}</div>
                ) : canDecide && block.approval ? (
                  <div className="row">
                    <button className="primary" onClick={() => onDecide(block.approval!.requestId, "allow")}>Allow</button>
                    <button onClick={() => onDecide(block.approval!.requestId, "deny")}>Deny</button>
                  </div>
                ) : null}
              </div>
            );
          }
          case "tasks":
            return (
              <ul key={block.id} className="tasks">
                {block.taskList?.items.map((item, index) => (
                  <li key={item.id ?? index} className={item.status}>
                    <span className="check">{item.status === "completed" ? "✓" : item.status === "in_progress" ? "◐" : "○"}</span>
                    {item.text}
                  </li>
                ))}
              </ul>
            );
          case "plan":
            return (
              <div key={block.id} className="plan">
                <div className="plan-label">Plan</div>
                <Markdown text={block.text} streaming={block.streaming} />
              </div>
            );
          case "system":
          case "handoff":
            return block.text.trim() ? (
              <div key={block.id} className={`system${block.notice ? ` ${block.notice}` : ""}`}>{block.text}</div>
            ) : null;
          default:
            return null;
        }
      })}
    </>
  );
}
