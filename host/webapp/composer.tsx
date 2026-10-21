import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { uploadAttachment } from "./api";
import type { Attachment } from "./model";
import { Icon, Menu, Spinner, type MenuItem } from "./ui";

/** What the composer hands over: the text, its files, and whether to plan first. */
export type Outgoing = { text: string; attachments: Attachment[]; plan: boolean };

/** The IDE's composer: a box with the working copy above the text, and a bar
 * of chips (model, effort, permissions, account) beside the send button. */
export function Composer({
  placeholder = "Ask, build, plan…",
  running = false,
  disabled = false,
  canPlan = false,
  seed,
  banner,
  onCancelBanner,
  onStop,
  onSend,
  context,
  tools,
}: {
  placeholder?: string;
  running?: boolean;
  disabled?: boolean;
  /** Offers the "Plan" toggle: the agent proposes a plan before building. */
  canPlan?: boolean;
  /** Replaces the draft when its nonce changes (editing the last message). */
  seed?: { text: string; nonce: number };
  banner?: string;
  onCancelBanner?: () => void;
  onStop?: () => void;
  onSend: (outgoing: Outgoing) => Promise<void>;
  context?: ReactNode;
  tools?: ReactNode;
}) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [sending, setSending] = useState(false);
  const [plan, setPlan] = useState(false);
  const [failure, setFailure] = useState<string>();
  const field = useRef<HTMLTextAreaElement>(null);
  const photos = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const canSend = !disabled && !sending && uploading === 0 && (!!text.trim() || attachments.length > 0);

  useEffect(() => {
    if (!seed) return;
    setText(seed.text);
    if (seed.text) field.current?.focus();
  }, [seed?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // Grows with its text, up to ten lines.
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 10 * 21 + 12)}px`;
  }, [text]);

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setFailure(undefined);
    try {
      await onSend({ text: text.trim(), attachments, plan });
      setText("");
      setAttachments([]);
      setPlan(false);
      navigator.vibrate?.(8);
    } catch (error) {
      // The draft stays for another try.
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  const upload = async (list: FileList | null) => {
    for (const file of Array.from(list ?? [])) {
      setUploading((n) => n + 1);
      try {
        const attachment = await uploadAttachment(file, file.name || `photo-${attachments.length + 1}.jpg`);
        setAttachments((items) => [...items, attachment]);
      } catch (error) {
        setFailure(error instanceof Error ? error.message : String(error));
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const attach: MenuItem[] = [
    { label: "Photos", icon: "photo", run: () => photos.current?.click() },
    { label: "Files", icon: "folder", run: () => files.current?.click() },
  ];

  return (
    <div className="composer">
      {banner ? (
        <div className="composer-banner">
          <span>{banner}</span>
          {onCancelBanner ? (
            <button className="link-button muted" onClick={onCancelBanner}>
              Cancel
            </button>
          ) : null}
        </div>
      ) : null}
      {context ? <div className="composer-context">{context}</div> : null}
      {attachments.length || uploading ? (
        <div className="composer-attachments">
          {attachments.map((attachment) => (
            <span key={attachment.id} className="attachment-chip">
              <Icon name={attachment.kind === "image" ? "photo" : "doc"} size={13} className="muted" />
              <span className="ellipsis">{attachment.name}</span>
              <button aria-label={`Remove ${attachment.name}`} onClick={() => setAttachments((items) => items.filter((item) => item.id !== attachment.id))}>
                <Icon name="xmark" size={11} />
              </button>
            </span>
          ))}
          {uploading ? <Spinner size={14} /> : null}
        </div>
      ) : null}
      <textarea
        ref={field}
        className="composer-field"
        rows={1}
        value={text}
        placeholder={running ? "Queue a follow-up…" : placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // A keyboard's ⌘/Ctrl-Return sends; Return alone is a new line, as on the phone.
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send();
          }
        }}
      />
      {failure ? <div className="composer-failure">{failure}</div> : null}
      <div className="composer-bar">
        <Menu className="composer-plus" ariaLabel="Attach" label={<Icon name="plus" size={17} />} items={attach} />
        <input ref={photos} type="file" accept="image/*" multiple hidden onChange={(event) => void upload(event.target.files).then(() => (event.target.value = ""))} />
        <input ref={files} type="file" multiple hidden onChange={(event) => void upload(event.target.files).then(() => (event.target.value = ""))} />
        {/* The last chips fade out under the send button, so the row reads as
            one that scrolls rather than one cut short. */}
        <div className="chips">
          {canPlan ? (
            <button className={`chip${plan ? " on" : ""}`} onClick={() => setPlan(!plan)}>
              Plan
            </button>
          ) : null}
          {tools}
        </div>
        {running && onStop && !canSend ? (
          <button className="send stop" aria-label="Stop" onClick={onStop}>
            <Icon name="stop" size={13} />
          </button>
        ) : (
          <button className={`send${canSend ? " ready" : ""}${sending ? " sending" : ""}`} aria-label="Send" disabled={!canSend} onClick={() => void send()}>
            <Icon name="arrowUp" size={15} />
          </button>
        )}
      </div>
    </div>
  );
}

/** A chip that opens a menu of choices, as the desktop's composer selects. */
export function Chip({
  icon,
  label,
  items,
  disabled,
  onOpen,
}: {
  icon?: ReactNode;
  label: string;
  items: MenuItem[] | (() => MenuItem[]);
  disabled?: boolean;
  onOpen?: () => void;
}) {
  return (
    <Menu
      className="chip"
      disabled={disabled}
      onOpen={onOpen}
      items={items}
      label={
        <>
          {icon}
          <span className="ellipsis">{label}</span>
          <Icon name="chevronDown" size={9} className="faint caret" />
        </>
      }
    />
  );
}

/** How full the context window is, as the desktop's ring. */
export function ContextMeter({ ratio }: { ratio: number }) {
  const circumference = 2 * Math.PI * 4.5;
  return (
    <span className="context-meter">
      <svg width={11} height={11} viewBox="0 0 11 11" aria-hidden>
        <circle cx="5.5" cy="5.5" r="4.5" fill="none" stroke="currentColor" strokeOpacity={0.4} strokeWidth={2} />
        <circle
          cx="5.5"
          cy="5.5"
          r="4.5"
          fill="none"
          stroke={ratio > 0.85 ? "var(--amber)" : "currentColor"}
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={`${ratio * circumference} ${circumference}`}
          transform="rotate(-90 5.5 5.5)"
        />
      </svg>
      <span className="mono-small">{Math.round(ratio * 100)}%</span>
    </span>
  );
}
