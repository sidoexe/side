import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ProjectMascot } from "../../src/features/projects/ui/ProjectMascot";
import { HarnessIcon as DesktopHarnessIcon } from "../../src/features/sessions/ui/HarnessIcon";
import type { HarnessId } from "../../src/features/sessions/model/session";
import { tabGroupColor } from "../../src/features/workspace/model/tabGroups";
import { useModel } from "./store";

/** The phone app's SF Symbols, drawn as strokes on a 24-unit grid. */
const ICONS: Record<string, ReactNode> = {
  tray: <path d="M3 13h5l1.5 3h5L16 13h5M5.5 5h13L21 13v6H3v-6z" />,
  folder: <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z" />,
  folderPlus: (
    <>
      <path d="M12 19.5H4.5A1.5 1.5 0 0 1 3 18V6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v3" />
      <path d="M18 15v6M15 18h6" />
    </>
  ),
  compose: (
    <>
      <path d="M11 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V13" />
      <path d="M17.5 3.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z" />
    </>
  ),
  ellipsis: (
    <g fill="currentColor" stroke="none">
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </g>
  ),
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.3 2.7 2.7L16 9.5" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  chevronRight: <path d="m9 5 7 7-7 7" />,
  chevronDown: <path d="m5 9 7 7 7-7" />,
  chevronUp: <path d="m5 15 7-7 7 7" />,
  back: <path d="M15 4 7 12l8 8" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 5 5" />
    </>
  ),
  pin: <path d="M9 3h6l-1 6 4 4H6l4-4zM12 13v8" />,
  pencil: <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />,
  archive: (
    <>
      <path d="M3 4h18v4H3zM5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
    </>
  ),
  trash: <path d="M4 6h16M9 6V4h6v2M6 6l1 14h10l1-14M10 10v6M14 10v6" />,
  branch: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="7" r="2" />
      <path d="M6 7v10M18 9c0 5-8 4-11.5 8.5" />
    </>
  ),
  offline: <path d="M2 8.5a15 15 0 0 1 4-2.7M10 5a15 15 0 0 1 12 3.5M5 12a10 10 0 0 1 3-1.8M14 10.5a10 10 0 0 1 5 1.5M8.5 15.5a5 5 0 0 1 7 0M12 19.5h.01M3 3l18 18" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z" />
    </>
  ),
  gauge: (
    <>
      <path d="M4.2 17a9 9 0 1 1 15.6 0" />
      <path d="m12 14 4-5" />
      <circle cx="12" cy="14" r="1" />
    </>
  ),
  bell: <path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20.5a2 2 0 0 0 4 0" />,
  arrowDown: <path d="M12 4v16M5 13l7 7 7-7" />,
  arrowUp: <path d="M12 20V4M5 11l7-7 7 7" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />,
  xmark: <path d="M6 6l12 12M18 6 6 18" />,
  photo: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="m21 16-5-5-9 8.5" />
    </>
  ),
  camera: (
    <>
      <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h3L9 4.5h6L16.5 7h3A1.5 1.5 0 0 1 21 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  doc: <path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8zM14 3v5h5" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" />
    </>
  ),
  play: <path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  refresh: <path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" />,
  external: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2 5-5 2 2-5z" />
    </>
  ),
  person: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="10" r="3" />
      <path d="M6.5 18.5a6.5 6.5 0 0 1 11 0" />
    </>
  ),
  download: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v8M8.5 12.5l3.5 3.5 3.5-3.5" />
    </>
  ),
  compress: <path d="M4 4h16M4 20h16M12 7v4M9 9l3 2.5L15 9M12 17v-4M9 15l3-2.5 3 2.5" />,
  parent: <path d="M9 4 4 9l5 5M4 9h10a6 6 0 0 1 6 6v5" />,
  desktop: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M9 20h6M12 16v4" />
    </>
  ),
  exclamation: <path d="M12 4v11M12 19.5v.5" strokeWidth={3.2} />,
};

export function Icon({ name, size = 18, className, style }: { name: keyof typeof ICONS | string; size?: number; className?: string; style?: CSSProperties }) {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden
    >
      {ICONS[name]}
    </svg>
  );
}

/** The desktop's 8×8 pixel mascot for a project, in its color; its two
 * frames alternate while the project has a turn running. */
export function Mascot({ seed, active, size = 14 }: { seed: string; active?: boolean; size?: number }) {
  return (
    <span className="mascot" style={{ width: size, height: size }}>
      <ProjectMascot project={seed} color={tabGroupColor(seed)} active={active} className="mascot-svg" />
    </span>
  );
}

/** The agent's logo, as the desktop's `HarnessIcon` draws it. */
export function HarnessIcon({ harness, size = 14 }: { harness: string; size?: number }) {
  return (
    <span className="harness" style={{ width: size, height: size }}>
      <DesktopHarnessIcon harness={harness as HarnessId} className="harness-svg" />
    </span>
  );
}

/** A small rounded label: "Needs you", "Interrupted". */
export function Pill({ text, color = "var(--amber)" }: { text: string; color?: string }) {
  return (
    <span className="pill" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
      {text}
    </span>
  );
}

/** The section labels of the sidebar: small, muted, uppercase. */
export function SectionLabel({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="section-label">
      <span>{text}</span>
      {children}
    </div>
  );
}

export function CardLabel({ text }: { text: string }) {
  return <div className="card-label">{text}</div>;
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />;
}

/** The look of a button: quiet by default, the content colour when primary. */
export function Button({
  children,
  onClick,
  primary,
  danger,
  disabled,
  icon,
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  icon?: string;
}) {
  return (
    <button className={`btn${primary ? " primary" : ""}${danger ? " danger" : ""}`} onClick={onClick} disabled={disabled}>
      {icon ? <Icon name={icon} size={14} /> : null}
      {children}
    </button>
  );
}

/** Runs `tick` now and every `ms` while the page is visible. `ms` may
 * change between ticks, as a session polls faster while it runs. */
export function usePoll(tick: () => Promise<unknown> | void, ms: () => number, deps: unknown[]) {
  const latest = useRef({ tick, ms });
  latest.current = { tick, ms };
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      if (!document.hidden) await Promise.resolve(latest.current.tick()).catch(() => undefined);
      if (!stopped) timer = setTimeout(loop, latest.current.ms());
    };
    const wake = () => {
      if (document.hidden || stopped) return;
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
  }, deps);
}

/** Re-renders every `ms`, for times shown relative to now. */
export function useTicker(ms: number) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
}

// MARK: Menus

export type MenuItem =
  | { kind?: "action"; label: string; icon?: string; checked?: boolean; danger?: boolean; detail?: string; run: () => void }
  | { kind: "section"; label: string }
  | { kind: "text"; label: string }
  | { kind: "divider" };

function MenuList({ items, close }: { items: MenuItem[]; close: () => void }) {
  return (
    <>
      {items.map((item, index) => {
        if (item.kind === "divider") return <div key={index} className="menu-divider" />;
        if (item.kind === "section") return <div key={index} className="menu-section">{item.label}</div>;
        if (item.kind === "text") return <div key={index} className="menu-text">{item.label}</div>;
        return (
          <button
            key={index}
            className={`menu-item${item.danger ? " danger" : ""}`}
            onClick={() => {
              close();
              item.run();
            }}
          >
            <span className="menu-check">{item.checked ? <Icon name="check" size={15} /> : null}</span>
            <span className="menu-label">
              <span>{item.label}</span>
              {item.detail ? <span className="menu-detail">{item.detail}</span> : null}
            </span>
            {item.icon ? <Icon name={item.icon} size={17} /> : null}
          </button>
        );
      })}
    </>
  );
}

/** A button that opens a menu beside it, as SwiftUI's `Menu`: below it when
 * there is room, above it near the bottom of the screen (composer chips). */
export function Menu({
  items,
  label,
  className = "bar-button",
  ariaLabel,
  disabled,
  onOpen,
}: {
  items: MenuItem[] | (() => MenuItem[]);
  label: ReactNode;
  className?: string;
  ariaLabel?: string;
  disabled?: boolean;
  onOpen?: () => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [rect, setRect] = useState<DOMRect>();
  useModel();
  return (
    <>
      <button
        ref={anchor}
        className={className}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          onOpen?.();
          setRect(anchor.current?.getBoundingClientRect());
        }}
      >
        {label}
      </button>
      {rect ? <Popover rect={rect} items={typeof items === "function" ? items() : items} close={() => setRect(undefined)} /> : null}
    </>
  );
}

function Popover({ rect, items, close }: { rect: DOMRect; items: MenuItem[]; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const width = Math.min(280, innerWidth - 16);
    const below = innerHeight - rect.bottom;
    const up = below < menu.offsetHeight + 16 && rect.top > below;
    const left = Math.max(8, Math.min(innerWidth - width - 8, rect.left + rect.width / 2 > innerWidth / 2 ? rect.right - width : rect.left));
    setStyle({
      width,
      left,
      maxHeight: (up ? rect.top : below) - 16,
      ...(up ? { bottom: innerHeight - rect.top + 6, transformOrigin: "bottom" } : { top: rect.bottom + 6, transformOrigin: "top" }),
    });
  }, [rect]);
  return createPortal(
    <div className="menu-layer" onClick={close} onContextMenu={(event) => event.preventDefault()}>
      <div ref={ref} className="menu" style={style} onClick={(event) => event.stopPropagation()}>
        <MenuList items={items} close={close} />
      </div>
    </div>,
    document.body,
  );
}

/** Long press (or right click) on a row: its actions, as iOS's context menu. */
export function useContextMenu(items: () => MenuItem[]) {
  const [open, setOpen] = useState<MenuItem[]>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const start = useRef<{ x: number; y: number }>(undefined);
  const fired = useRef(false);
  const cancel = () => clearTimeout(timer.current);
  const handlers = {
    onPointerDown: (event: React.PointerEvent) => {
      if (event.pointerType === "mouse") return;
      fired.current = false;
      start.current = { x: event.clientX, y: event.clientY };
      timer.current = setTimeout(() => {
        fired.current = true;
        navigator.vibrate?.(10);
        setOpen(items());
      }, 450);
    },
    onPointerMove: (event: React.PointerEvent) => {
      if (start.current && Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y) > 8) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (event: React.MouseEvent) => {
      event.preventDefault();
      cancel();
      setOpen(items());
    },
    onClickCapture: (event: React.MouseEvent) => {
      // The press that opened the menu is not also a tap on the row.
      if (fired.current) {
        event.preventDefault();
        event.stopPropagation();
        fired.current = false;
      }
    },
  };
  const menu = open ? (
    <ActionSheet onClose={() => setOpen(undefined)}>
      <MenuList items={open} close={() => setOpen(undefined)} />
    </ActionSheet>
  ) : null;
  return { handlers, menu };
}

// MARK: Sheets and dialogs

/** A list of actions that rises from the bottom. */
export function ActionSheet({ title, children, onClose }: { title?: string; children: ReactNode; onClose: () => void }) {
  // The finger that held a row to open this lifts over it: that click is
  // not a choice. Only a press that starts here counts.
  const armed = useRef(false);
  return createPortal(
    <div
      className="scrim"
      onPointerDownCapture={() => (armed.current = true)}
      onClickCapture={(event) => {
        if (armed.current) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={onClose}
    >
      <div className="action-sheet" onClick={(event) => event.stopPropagation()}>
        <div className="menu action-group">
          {title ? <div className="action-title">{title}</div> : null}
          {children}
        </div>
        <button className="action-cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** A sheet over the screen, with its own bar, as `.sheet` with its detents. */
export function Sheet({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose]);
  return createPortal(
    <div className="scrim sheet-scrim" onClick={onClose}>
      <div className="sheet" onClick={(event) => event.stopPropagation()}>
        <div className="grabber" />
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** The app's alerts: a message, a confirmation, or a name to type. */
export function DialogHost() {
  const model = useModel();
  const dialog = model.state.dialog;
  const [text, setText] = useState("");
  useEffect(() => {
    if (dialog?.kind === "prompt") setText(dialog.initial);
  }, [dialog]);
  if (!dialog) return null;
  const close = () => model.set({ dialog: undefined });
  if (dialog.kind === "confirm")
    return (
      <ActionSheet title={dialog.title} onClose={close}>
        <button
          className="menu-item danger center"
          onClick={() => {
            close();
            dialog.run();
          }}
        >
          {dialog.action}
        </button>
      </ActionSheet>
    );
  return createPortal(
    <div className="scrim center">
      <form
        className="alert"
        onSubmit={(event) => {
          event.preventDefault();
          close();
          if (dialog.kind === "prompt" && text.trim()) dialog.run(text.trim());
        }}
      >
        <div className="alert-body">
          <div className="alert-title">{dialog.title}</div>
          {dialog.kind === "alert" ? <div className="alert-message">{dialog.message}</div> : null}
          {dialog.kind === "prompt" ? (
            <input className="alert-field" autoFocus value={text} placeholder="Name" onChange={(event) => setText(event.target.value)} />
          ) : null}
        </div>
        <div className="alert-buttons">
          {dialog.kind === "prompt" ? (
            <>
              <button type="button" onClick={close}>
                Cancel
              </button>
              <button type="submit" className="strong">
                Save
              </button>
            </>
          ) : (
            <button type="submit" className="strong">
              OK
            </button>
          )}
        </div>
      </form>
    </div>,
    document.body,
  );
}

/** The navigation bar of a screen: back, a title, and its buttons. */
export function NavBar({
  title,
  subtitle,
  leading,
  trailing,
  back,
  sidebar,
}: {
  title?: ReactNode;
  subtitle?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  back?: () => void;
  sidebar?: boolean;
}) {
  return (
    <header className={`navbar${sidebar ? " sidebar" : ""}`}>
      <div className="navbar-side">
        {back ? (
          <button className="bar-button back" onClick={back} aria-label="Back">
            <Icon name="back" size={22} />
          </button>
        ) : null}
        {leading}
      </div>
      {title ? (
        <div className="navbar-title">
          <div className="ellipsis">{title}</div>
          {subtitle ? <div className="navbar-subtitle ellipsis">{subtitle}</div> : null}
        </div>
      ) : null}
      <div className="navbar-side trailing">{trailing}</div>
    </header>
  );
}

/** A switch, as SwiftUI's `Toggle`. */
export function Switch({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label?: string }) {
  return (
    <button className={`switch${on ? " on" : ""}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

/** Copies text, falling back to a hidden field where the clipboard API is missing. */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const field = document.createElement("textarea");
    field.value = text;
    document.body.append(field);
    field.select();
    document.execCommand("copy");
    field.remove();
  }
}
