import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { clampUsedPercent, formatUsagePercent } from "../../providers/model/rateLimits";
import { barClass } from "../../providers/ui/ProviderAccountUsage";
import { useShowRemainingUsage } from "../../settings/model/displayPrefs";
import { HarnessIcon } from "../../sessions/ui/HarnessIcon";
import { Check } from "../../../shared/ui/icons";
import { Popover, type PopoverDismissReason } from "../../../shared/ui/Popover";
import type { HostAccountSummary } from "../model/protocol";
import { useRemoteAccountSlot } from "./remoteAccountSlot";

const DEFAULT = "default";
const DEFAULT_LABEL = "Default account";

type Window = { key: string; label: string; used: number };

function windows(account: HostAccountSummary | undefined): Window[] {
  const usage = account?.usage;
  if (!usage) return [];
  return [
    usage.fiveHour ? { key: "5h", label: "5h", used: usage.fiveHour.used } : undefined,
    usage.sevenDay ? { key: "7d", label: "7d", used: usage.sevenDay.used } : undefined,
  ].filter((entry): entry is Window => !!entry);
}

const limited = (account: HostAccountSummary | undefined) =>
  !!account?.usage?.blockedUntil && account.usage.blockedUntil > Date.now();

function UsageText({ account }: { account: HostAccountSummary | undefined }) {
  const showRemaining = useShowRemainingUsage();
  if (limited(account)) return <span className="text-amber-600 dark:text-amber-300">limited</span>;
  const entries = windows(account);
  if (!entries.length) return null;
  return (
    <span className="flex min-w-0 items-center gap-1 tabular-nums">
      {entries.map((entry, index) => (
        <span key={entry.key} className="inline-flex items-center gap-1">
          {index > 0 ? <span className="text-content/25">·</span> : null}
          <span>
            {formatUsagePercent(
              showRemaining ? 100 - clampUsedPercent(entry.used) : entry.used,
            )}{" "}
            {entry.label}
          </span>
        </span>
      ))}
    </span>
  );
}

function MiniBar({ account }: { account: HostAccountSummary | undefined }) {
  const showRemaining = useShowRemainingUsage();
  const entries = windows(account);
  if (!entries.length || limited(account)) return null;
  const pct = clampUsedPercent(Math.max(...entries.map((entry) => entry.used)));
  return (
    <span className="h-1 w-8 shrink-0 overflow-hidden rounded-full bg-content/10" aria-hidden>
      <span
        className={`block h-full rounded-full ${barClass(pct)}`}
        style={{ width: `${showRemaining ? 100 - pct : pct}%` }}
      />
    </span>
  );
}

/** Which host account a remote session runs on, in the app footer where
 * this computer's usage chips would be. */
export function RemoteAccountPicker({
  sessionId,
  accounts,
  value,
  disabled,
  onChange,
}: {
  sessionId: string;
  accounts: HostAccountSummary[];
  value: string | undefined;
  disabled?: boolean;
  onChange: (id: string | undefined) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const slot = useRemoteAccountSlot(sessionId);
  if (!accounts.length || !slot) return null;
  const selected = value ?? DEFAULT;
  const active = accounts.find((account) => account.id === selected);
  const provider = accounts[0].provider;
  const options = [
    ...accounts.map((account) => ({ id: account.id, label: account.label, account })),
    { id: DEFAULT, label: DEFAULT_LABEL, account: undefined },
  ];

  const dismiss = (reason: PopoverDismissReason) => {
    setOpen(false);
    if (reason === "escape") requestAnimationFrame(() => trigger.current?.focus());
  };

  return createPortal(
    <>
      <button
        ref={trigger}
        type="button"
        className="-mx-1 inline-flex h-5 min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-1 text-content/55 transition-[background-color,color,transform] duration-150 ease-out hover:bg-content/10 hover:text-content focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50"
        aria-label={`Host account: ${active?.label ?? DEFAULT_LABEL}`}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Account this conversation runs on, on the host"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <HarnessIcon harness={provider} className="size-3 shrink-0" />
        <span className="max-w-32 truncate text-content/45">
          {active?.label ?? DEFAULT_LABEL}
        </span>
        <MiniBar account={active} />
        <UsageText account={active} />
      </button>
      {open ? (
        <Popover
          anchor={trigger}
          side="top"
          align="start"
          gap={7}
          autoFocus
          onDismiss={dismiss}
          role="menu"
          aria-label="Host accounts"
          className="min-w-[15rem] p-1"
        >
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              role="menuitemradio"
              aria-checked={option.id === selected}
              className="flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] leading-none text-content hover:bg-content/10"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setOpen(false);
                if (option.id !== selected)
                  onChange(option.id === DEFAULT ? undefined : option.id);
              }}
            >
              <span className="grid size-3 shrink-0 place-items-center">
                {option.id === selected ? (
                  <Check className="size-3" strokeWidth={2} aria-hidden />
                ) : null}
              </span>
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              <span className="shrink-0 text-[11px] text-content/40">
                <UsageText account={option.account} />
              </span>
            </button>
          ))}
        </Popover>
      ) : null}
    </>,
    slot,
  );
}
