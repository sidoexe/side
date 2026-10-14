import { useEffect, useRef, useState, type ReactNode } from "react";
import type { RemoteAttachment } from "../../src/features/connections/model/protocol";
import type { RuntimeMode } from "../../src/features/sessions/model/session";
import { buildQuestionReply, type UserQuestionPrompt, type UserQuestionReply } from "../../src/features/sessions/model/userQuestion";
import { rpc, uploadAttachment } from "./api";

export type Route =
  | { kind: "home" }
  | { kind: "session"; projectId: string; sessionId: string }
  | { kind: "new"; projectId: string }
  | { kind: "colleagues" }
  | { kind: "automations" };

export function parseRoute(): Route {
  const [kind, projectId, sessionId] = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (kind === "s" && projectId && sessionId) return { kind: "session", projectId, sessionId };
  if (kind === "new" && projectId) return { kind: "new", projectId };
  if (kind === "colleagues" || kind === "automations") return { kind };
  return { kind: "home" };
}

export function go(route: Route) {
  location.hash =
    route.kind === "session"
      ? `#/s/${encodeURIComponent(route.projectId)}/${encodeURIComponent(route.sessionId)}`
      : route.kind === "new"
        ? `#/new/${encodeURIComponent(route.projectId)}`
        : route.kind === "colleagues" || route.kind === "automations"
          ? `#/${route.kind}`
          : "#/";
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parseRoute);
  useEffect(() => {
    const update = () => setRoute(parseRoute());
    addEventListener("hashchange", update);
    return () => removeEventListener("hashchange", update);
  }, []);
  return route;
}

/** Runs `tick` now and every `ms` while the page is visible. */
export function usePoll(tick: () => Promise<void> | void, ms: number, deps: unknown[]) {
  const latest = useRef(tick);
  latest.current = tick;
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      if (!document.hidden) await Promise.resolve(latest.current()).catch(() => undefined);
      if (!stopped) timer = setTimeout(loop, ms);
    };
    const wake = () => {
      if (document.hidden) return;
      clearTimeout(timer);
      void loop();
    };
    void loop();
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps]);
}

export const ago = (time?: number) => {
  if (!time) return "";
  const s = Math.max(0, (Date.now() - time) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

export const tilde = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+/, "~");

export const BranchIcon = () => (
  <svg className="glyph" viewBox="0 0 16 16" aria-hidden>
    <circle cx="5" cy="4" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="5" cy="12" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="11" cy="6" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <path d="M5 5.6v4.8M11 7.6c0 2-2 2.4-4.6 3.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);

export const MODES: { id: RuntimeMode; label: string }[] = [
  { id: "supervised", label: "Ask" },
  { id: "auto-accept-edits", label: "Accept edits" },
  { id: "auto", label: "Auto" },
  { id: "full-access", label: "Full access" },
];

/** A native select dressed as one of the composer's chips. */
export function Chip<T extends string>({
  value,
  onChange,
  children,
  icon,
  label,
  disabled,
}: {
  value: T;
  onChange: (value: T) => void;
  children: React.ReactNode;
  icon?: React.ReactNode;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className={`chip${disabled ? " disabled" : ""}`}>
      {icon}
      <span className="ellipsis">{label}</span>
      <svg className="chip-caret" viewBox="0 0 16 16" aria-hidden><path d="M4.5 6.5L8 10l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as T)}>{children}</select>
    </label>
  );
}

/** A two-state chip, such as Plan. */
export function Toggle({ on, onChange, children }: { on: boolean; onChange: (on: boolean) => void; children: ReactNode }) {
  return (
    <button type="button" className={`chip${on ? " on" : ""}`} onClick={() => onChange(!on)} aria-pressed={on}>
      {children}
    </button>
  );
}

export type Outgoing = {
  text: string;
  attachments: RemoteAttachment[];
  plan: boolean;
  /** What the provider receives when skills were expanded into the text. */
  prompt?: string;
};

type Skill = { name: string; description: string; path: string };
type Suggestion = { label: string; detail?: string; insert: string };
// Harnesses that run `/skill` themselves; others get the skill's body.
const NATIVE_SKILLS = new Set(["pi", "omp", "devin"]);

/** Files after `@` and skills after a leading `/`, from the host. */
function useSuggestions(text: string, caret: number, scope?: { projectId: string; cwd: string; harness?: string }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [files, setFiles] = useState<Suggestion[]>([]);
  const before = text.slice(0, caret);
  const mention = /(^|\s)@([^\s@]*)$/.exec(before);
  const command = /^\/([\w:.-]*)$/.exec(before);
  useEffect(() => {
    if (!scope) return;
    rpc<Skill[]>("workspace.run", { command: "list_skills", args: { cwd: scope.cwd } }).then(setSkills, () => setSkills([]));
  }, [scope?.cwd]);
  const query = mention?.[2];
  useEffect(() => {
    if (!scope || query === undefined) return setFiles([]);
    const timer = setTimeout(() => {
      rpc<{ name: string; path: string; isDir: boolean }[]>("files.search", { projectId: scope.projectId, query }).then(
        (found) => setFiles(found.slice(0, 8).map((file) => ({ label: file.name, detail: file.path, insert: `@${file.path}${file.isDir ? "/" : ""} ` }))),
        () => setFiles([]),
      );
    }, 120);
    return () => clearTimeout(timer);
  }, [query, scope?.projectId]);
  if (!scope) return { items: [], replace: 0, skills };
  if (mention) return { items: files, replace: mention[2].length + 1, skills };
  if (command) {
    const typed = command[1].toLowerCase();
    const items = skills
      .filter((skill) => skill.name.toLowerCase().includes(typed))
      .slice(0, 8)
      .map((skill) => ({ label: `/${skill.name}`, detail: skill.description, insert: `/${skill.name} ` }));
    return { items, replace: command[1].length + 1, skills };
  }
  return { items: [], replace: 0, skills };
}

/** The text an agent receives: each `/skill` used is preceded by its body,
 * as the desktop sends it. */
async function withSkills(text: string, skills: Skill[], harness?: string): Promise<string | undefined> {
  if (!harness || NATIVE_SKILLS.has(harness)) return undefined;
  const used = skills.filter((skill) => new RegExp(`(^|\\s)/${skill.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`).test(text));
  if (!used.length) return undefined;
  const bodies = await Promise.all(
    used.map((skill) => rpc<string>("workspace.run", { command: "read_text_file", args: { path: skill.path } }).catch(() => "")),
  );
  const blocks = used.flatMap((skill, index) => (bodies[index].trim() ? [`## /${skill.name}\n\n${bodies[index].trim()}`] : []));
  if (!blocks.length) return undefined;
  return [
    "The user invoked skill(s) with /name. Follow every instruction in each skill body.",
    "",
    blocks.join("\n\n"),
    "",
    "---",
    "",
    text,
  ].join("\n");
}

export function Composer({
  placeholder,
  running,
  disabled,
  onSend,
  onStop,
  context,
  tools,
  seed,
  banner,
  scope,
  children,
}: {
  /** Where `@` finds files and `/` finds skills. */
  scope?: { projectId: string; cwd: string; harness?: string };
  placeholder: string;
  context?: ReactNode;
  tools?: ReactNode;
  running?: boolean;
  disabled?: boolean;
  onSend: (message: Outgoing) => Promise<void>;
  onStop?: () => void;
  /** Text put in the composer from outside, e.g. a message being edited. */
  seed?: { text: string; nonce: number };
  /** Shown above the text, e.g. "Editing your last message". */
  banner?: ReactNode;
  children?: ReactNode;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [plan, setPlan] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const suggestions = useSuggestions(text, caret, scope);
  const area = useRef<HTMLTextAreaElement>(null);
  const pick = (item: Suggestion) => {
    const start = caret - suggestions.replace;
    const next = text.slice(0, start) + item.insert + text.slice(caret);
    setText(next);
    const position = start + item.insert.length;
    setCaret(position);
    setActive(0);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(position, position);
    });
  };
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!seed) return;
    setText(seed.text);
    area.current?.focus();
  }, [seed?.nonce]);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);
  const submit = async () => {
    let value = text.trim();
    if ((!value && !files.length) || sending || disabled) return;
    // `/plan` at the start asks for a plan, as in the desktop composer.
    const planned = plan || /^\/plan\b/.test(value);
    if (/^\/plan\b/.test(value)) value = value.replace(/^\/plan\b\s*/, "");
    setSending(true);
    setError("");
    try {
      const attachments = [];
      for (const file of files) attachments.push(await uploadAttachment(file));
      const prompt = await withSkills(value, suggestions.skills, scope?.harness);
      await onSend({ text: value, attachments, plan: planned, ...(prompt ? { prompt } : {}) });
      setText("");
      setFiles([]);
      setPlan(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="composer">
      {children}
      <div
        className="composer-box"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          setFiles([...files, ...Array.from(event.dataTransfer.files)]);
        }}
      >
        {banner ? <div className="composer-banner">{banner}</div> : null}
        {context ? <div className="composer-context">{context}</div> : null}
        {files.length ? (
          <div className="composer-files">
            {files.map((file, index) => (
              <span key={index} className="file-chip">
                {file.type.startsWith("image/") ? <img src={URL.createObjectURL(file)} alt="" /> : null}
                <span className="ellipsis">{file.name}</span>
                <button type="button" aria-label={`Remove ${file.name}`} onClick={() => setFiles(files.filter((_, i) => i !== index))}>
                  <svg className="glyph" viewBox="0 0 16 16" aria-hidden><path d="M5 5l6 6M11 5l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {suggestions.items.length ? (
          <div className="suggestions">
            {suggestions.items.map((item, index) => (
              <button
                key={item.insert}
                type="button"
                className={index === active ? "active" : ""}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(item)}
              >
                <span className="suggestion-label">{item.label}</span>
                {item.detail ? <span className="suggestion-detail ellipsis">{item.detail}</span> : null}
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          ref={area}
          rows={1}
          value={text}
          placeholder={plan ? "Describe what to plan…" : placeholder}
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart ?? event.target.value.length);
            setActive(0);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
          onPaste={(event) => {
            const pasted = Array.from(event.clipboardData.files);
            if (pasted.length) {
              event.preventDefault();
              setFiles([...files, ...pasted]);
            }
          }}
          onKeyDown={(event) => {
            if (suggestions.items.length) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                setActive((active + step + suggestions.items.length) % suggestions.items.length);
                return;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                pick(suggestions.items[active]);
                return;
              }
            }
            // Enter sends on a keyboard; on touch screens the button does.
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && matchMedia("(pointer: fine)").matches) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        {error ? <div className="composer-error">{error}</div> : null}
        <div className="composer-bar">
          <button type="button" className="square ghost" aria-label="Attach files" onClick={() => picker.current?.click()}>
            <svg className="glyph" viewBox="0 0 16 16" aria-hidden><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              setFiles([...files, ...Array.from(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
          <span className="composer-tools">
            {tools}
            <Toggle on={plan} onChange={setPlan}>Plan</Toggle>
          </span>
          {running && onStop ? (
            <button type="button" className="square stop" onClick={onStop} aria-label="Stop">
              <svg className="glyph" viewBox="0 0 16 16" aria-hidden><rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="currentColor" /></svg>
            </button>
          ) : null}
          <button
            type="button"
            className={`square send${sending ? " busy" : ""}`}
            disabled={(!text.trim() && !files.length) || sending || disabled}
            onClick={() => void submit()}
            aria-label="Send"
          >
            <svg className="glyph" viewBox="0 0 16 16" aria-hidden><path d="M8 12.5v-9M4 7.5l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
      </div>
    </div>
  );
}

export function Question({ prompt, onReply }: { prompt: UserQuestionPrompt; onReply: (reply: UserQuestionReply) => void }) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  return (
    <div className="question">
      {prompt.questions.map((question) => (
        <fieldset key={question.id}>
          <legend>{question.prompt}</legend>
          {question.options.map((option) => {
            const selected = answers[question.id]?.includes(option.id) ?? false;
            return (
              <button
                key={option.id}
                className={`option${selected ? " selected" : ""}`}
                onClick={() =>
                  setAnswers({
                    ...answers,
                    [question.id]: question.multiSelect
                      ? selected
                        ? answers[question.id].filter((id) => id !== option.id)
                        : [...(answers[question.id] ?? []), option.id]
                      : [option.id],
                  })
                }
              >
                <strong>{option.label}</strong>
                {option.description ? <span>{option.description}</span> : null}
              </button>
            );
          })}
          {question.allowCustom ? (
            <input
              placeholder="Other answer"
              value={custom[question.id] ?? ""}
              onChange={(event) => setCustom({ ...custom, [question.id]: event.target.value })}
            />
          ) : null}
        </fieldset>
      ))}
      <div className="row">
        <button className="primary" onClick={() => onReply(buildQuestionReply(prompt.questions, answers, custom))}>
          Answer
        </button>
        <button onClick={() => onReply({ kind: "skipped" })}>Skip</button>
      </div>
    </div>
  );
}

type PushState = "unsupported" | "install" | "off" | "on" | "denied" | "working";

/** Notifications from the host: on iPhone they need the app on the Home
 * Screen, elsewhere a browser that supports Web Push. */
export function useNotifications(available: boolean) {
  const [state, setState] = useState<PushState>("working");
  const standalone =
    matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  useEffect(() => {
    if (!available) return setState("unsupported");
    if (!("serviceWorker" in navigator) || !("PushManager" in window))
      return setState(/iPhone|iPad/.test(navigator.userAgent) && !standalone ? "install" : "unsupported");
    if (Notification.permission === "denied") return setState("denied");
    navigator.serviceWorker
      .register("/web/sw.js", { scope: "/web/" })
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => setState(subscription ? "on" : "off"), () => setState("off"));
  }, [available, standalone]);
  const toggle = async () => {
    if (state !== "on" && state !== "off") return;
    const previous = state;
    setState("working");
    try {
      const registration = await navigator.serviceWorker.register("/web/sw.js", { scope: "/web/" });
      await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      if (previous === "on") {
        if (existing) {
          await rpc("push.unsubscribe", { endpoint: existing.endpoint }).catch(() => undefined);
          await existing.unsubscribe();
        }
        return setState("off");
      }
      if ((await Notification.requestPermission()) !== "granted") return setState("denied");
      const { publicKey } = await rpc<{ publicKey: string }>("push.key");
      const key = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      const subscription = existing ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
      await rpc("push.subscribe", { subscription: subscription.toJSON() });
      setState("on");
    } catch {
      setState(previous);
    }
  };
  return { state, toggle };
}
