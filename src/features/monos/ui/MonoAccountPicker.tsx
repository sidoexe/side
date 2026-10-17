import { useRef, useState, useSyncExternalStore } from "react";
import {
  clampUsedPercent,
  formatResetDuration,
  formatUsagePercent,
  type ProviderRateLimits,
  type RateLimitWindow,
} from "../../providers/model/rateLimits";
import {
  getAllRateLimits,
  getCachedRateLimits,
  loadRateLimits,
  subscribeRateLimits,
} from "../../providers/model/rateLimitsCache";
import {
  providerAccounts,
  sameProviderAccountId,
  type ProviderAccountProvider,
} from "../../providers/model/providerAccounts";
import { barClass, UsageMeter } from "../../providers/ui/ProviderAccountUsage";
import { useShowRemainingUsage } from "../../settings/model/displayPrefs";
import { HarnessIcon } from "../../sessions/ui/HarnessIcon";
import { Check, Plus, RefreshCw } from "../../../shared/ui/icons";
import { Popover, type PopoverDismissReason } from "../../../shared/ui/Popover";

const MENU_ITEM =
  "flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] leading-none text-content hover:bg-content/10";

/** A window whose reset time has passed is empty again. */
const live = (
  window: RateLimitWindow | null,
  now: number,
): RateLimitWindow | undefined =>
  !window
    ? undefined
    : window.resetsAt != null && window.resetsAt <= now
      ? { ...window, usedPercent: 0, resetsAt: null }
      : window;

/** "just now", "4 min ago", for the newest reading among the accounts. */
function readAt(
  limits: readonly ProviderRateLimits[],
  now: number,
): string | undefined {
  const at = Math.max(0, ...limits.map((entry) => entry.updatedAt ?? 0));
  if (!at) return undefined;
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "updated just now";
  if (minutes < 60) return `updated ${minutes} min ago`;
  return `updated ${formatResetDuration(now - at)} ago`;
}

function AccountUsage({
  limits,
  now,
}: {
  limits: ProviderRateLimits;
  now: number;
}) {
  const session = live(limits.session, now);
  const weekly = live(limits.weekly, now);
  return (
    <>
      {session || weekly ? (
        <div className="flex gap-3">
          {session ? (
            <UsageMeter
              title="5h"
              window={session}
              now={now}
              className="w-[7.5rem]"
            />
          ) : null}
          {weekly ? (
            <UsageMeter
              title="Weekly"
              window={weekly}
              now={now}
              className="w-[7.5rem]"
            />
          ) : null}
        </div>
      ) : limits.error ? null : (
        <p className="text-[10px] leading-3 text-content/40">
          No usage read yet
        </p>
      )}
      {limits.error ? (
        <p className="text-[10px] leading-3 text-red-600 dark:text-red-300">
          {limits.error}
        </p>
      ) : null}
    </>
  );
}

/**
 * A Colleague's account under its composer, as a remote session's host
 * accounts: each account with both windows, the Balanced choice that keeps
 * it on the one with the most room, and a way to manage them.
 */
export function MonoAccountPicker({
  provider,
  value,
  balanced,
  disabled,
  onChange,
  onBalanced,
  onManageAccounts,
}: {
  provider: ProviderAccountProvider;
  /** The account it runs on now. */
  value: string | undefined;
  balanced: boolean;
  disabled?: boolean;
  onChange: (accountId: string) => void;
  onBalanced: () => void;
  onManageAccounts?: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const showRemaining = useShowRemainingUsage();
  // Any account's new reading redraws the menu.
  useSyncExternalStore(subscribeRateLimits, getAllRateLimits, getAllRateLimits);
  const accounts = providerAccounts(provider);
  const current =
    accounts.find((account) => sameProviderAccountId(account.id, value)) ??
    accounts[0];
  const limitsOf = (id: string) => getCachedRateLimits(provider, id);
  const active = current ? limitsOf(current.id) : undefined;

  const refresh = async (force: boolean) => {
    setRefreshing(true);
    try {
      await Promise.all(
        accounts.map((account) => loadRateLimits(provider, account.id, force)),
      );
    } finally {
      setNow(Date.now());
      setRefreshing(false);
    }
  };

  const dismiss = (reason: PopoverDismissReason) => {
    setOpen(false);
    if (reason === "escape")
      requestAnimationFrame(() => trigger.current?.focus());
  };

  const session = active ? live(active.session, now) : undefined;
  const weekly = active ? live(active.weekly, now) : undefined;
  const shown = (window: RateLimitWindow) => {
    const pct = clampUsedPercent(window.usedPercent);
    return formatUsagePercent(showRemaining ? 100 - pct : pct);
  };
  const pct = clampUsedPercent(
    Math.max(session?.usedPercent ?? 0, weekly?.usedPercent ?? 0),
  );

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="inline-flex h-6 min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 text-[11px] text-content/55 transition-[background-color,color,transform] duration-150 ease-out hover:bg-content/10 hover:text-content focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50"
        aria-label={`Account: ${balanced ? "Balanced" : (current?.label ?? "Default")}`}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Account this Colleague runs on"
        disabled={disabled}
        onClick={() => {
          setOpen((shownNow) => !shownNow);
          setNow(Date.now());
          if (!open) void refresh(false);
        }}
      >
        <HarnessIcon harness={provider} className="size-3 shrink-0" />
        <span className="max-w-28 truncate text-content/45">
          {balanced ? "Balanced" : (current?.label ?? "Default")}
        </span>
        {session || weekly ? (
          <>
            <span
              className="h-1 w-8 shrink-0 overflow-hidden rounded-full bg-content/10"
              aria-hidden
            >
              <span
                className={`block h-full rounded-full ${barClass(pct)}`}
                style={{ width: `${showRemaining ? 100 - pct : pct}%` }}
              />
            </span>
            <span className="tabular-nums">
              {[
                session ? `${shown(session)} 5h` : "",
                weekly ? `${shown(weekly)} 7d` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </>
        ) : null}
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
          aria-label="Colleague accounts"
          className="w-[18.5rem] p-1"
        >
          <div className="flex h-7 items-center gap-2 pl-2 pr-0.5 text-[11px] text-content/40">
            <span className="min-w-0 flex-1 truncate">
              Accounts
              {readAt(
                accounts.map((account) => limitsOf(account.id)),
                now,
              )
                ? ` · ${readAt(
                    accounts.map((account) => limitsOf(account.id)),
                    now,
                  )}`
                : ""}
            </span>
            <button
              type="button"
              aria-label="Refresh usage"
              title="Read every account's usage now"
              disabled={refreshing}
              className="grid size-6 place-items-center rounded-md text-content/40 hover:bg-content/10 hover:text-content disabled:opacity-40"
              onClick={() => void refresh(true)}
            >
              <RefreshCw
                className={`size-3 ${refreshing ? "animate-spin" : ""}`}
                strokeWidth={1.75}
                aria-hidden
              />
            </button>
          </div>
          {accounts.length > 1 ? (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={balanced}
              className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] leading-none text-content hover:bg-content/10"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setOpen(false);
                if (!balanced) onBalanced();
              }}
            >
              <span className="grid size-3 shrink-0 place-items-center pt-px">
                {balanced ? (
                  <Check className="size-3" strokeWidth={2} aria-hidden />
                ) : null}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span>Balanced</span>
                <span className="text-[10px] leading-[13px] text-content/40">
                  Between all {accounts.length} accounts · runs on the most
                  weekly room, moves on at a limit with its conversation
                  {balanced && current ? (
                    <>
                      {" · now on "}
                      <span className="text-content/60">{current.label}</span>
                    </>
                  ) : null}
                </span>
              </span>
            </button>
          ) : null}
          {accounts.map((account) => {
            const checked = !balanced && account.id === current?.id;
            return (
              <button
                key={account.id}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] leading-none text-content hover:bg-content/10"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setOpen(false);
                  if (!checked) onChange(account.id);
                }}
              >
                <span className="grid size-3 shrink-0 place-items-center pt-px">
                  {checked ? (
                    <Check className="size-3" strokeWidth={2} aria-hidden />
                  ) : null}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className="truncate">{account.label}</span>
                  <AccountUsage limits={limitsOf(account.id)} now={now} />
                </span>
              </button>
            );
          })}
          {onManageAccounts ? (
            <>
              <div role="separator" className="my-1 h-px bg-content/10" />
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM}
                onClick={() => {
                  setOpen(false);
                  onManageAccounts();
                }}
              >
                <Plus className="size-3 shrink-0" aria-hidden />
                <span>Add or manage accounts…</span>
              </button>
            </>
          ) : null}
        </Popover>
      ) : null}
    </>
  );
}
