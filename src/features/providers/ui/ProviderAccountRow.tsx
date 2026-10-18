import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { HarnessId } from "../../sessions/model/session";
import {
  balancedProviderAccounts,
  providerAccounts,
  setProviderAccountBalanced,
  subscribeProviderAccounts,
  supportsProviderAccounts,
  type ProviderAccount,
  type ProviderAccountProvider,
} from "../model/providerAccounts";
import {
  formatWindowLabel,
  type ProviderRateLimits,
} from "../model/rateLimits";
import { accountStatus } from "../model/accountUsage";
import { needsProviderLogin } from "../model/providerSignIn";
import {
  AccountStatusLabel,
  meterWindows,
  UsageMeter,
} from "./ProviderAccountUsage";
import { SignInAgainButton } from "./SignInAgainButton";
import { Check } from "../../../shared/ui/icons";

/** A conversation's account that was removed since it started. */
export const REMOVED_ACCOUNT_LABEL = "Removed account";

/** The provider's accounts, redrawn when one is added, renamed or removed. */
export function useProviderAccounts(harness: HarnessId): ProviderAccount[] {
  const snapshot = useSyncExternalStore(
    subscribeProviderAccounts,
    () =>
      supportsProviderAccounts(harness)
        ? JSON.stringify(providerAccounts(harness))
        : "[]",
    () => "[]",
  );
  return useMemo(() => JSON.parse(snapshot) as ProviderAccount[], [snapshot]);
}

/** The ids of the accounts Balanced may use, redrawn when that changes. */
export function useBalancedAccountIds(harness: HarnessId): ReadonlySet<string> {
  const snapshot = useSyncExternalStore(
    subscribeProviderAccounts,
    () =>
      supportsProviderAccounts(harness)
        ? balancedProviderAccounts(harness)
            .map((account) => account.id)
            .join("\0")
        : "",
    () => "",
  );
  return useMemo(
    () => new Set(snapshot ? snapshot.split("\0") : []),
    [snapshot],
  );
}

/** "A", "A and B", "A, B and C". */
export function balancedPoolLabel(labels: readonly string[]): string {
  return labels.length < 2
    ? (labels[0] ?? "")
    : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

const ROW =
  "pointer-events-none relative flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[11px] ring-1 ring-inset transition-colors";

function rowClass(checked: boolean, highlighted: boolean) {
  return `${ROW} ${
    checked
      ? "bg-accent/10 text-content ring-accent/20"
      : highlighted
        ? "bg-content/[0.07] text-content ring-content/[0.08]"
        : "bg-content/[0.035] text-content/70 ring-content/[0.06]"
  }`;
}

/** The row's own target, beside its other buttons rather than around them. */
function RowTarget({
  id,
  role,
  checked,
  label,
  describedBy,
  disabled,
  onSelect,
  onHighlight,
}: {
  id?: string;
  role?: "menuitemradio" | "option";
  checked: boolean;
  label: string;
  describedBy?: string;
  disabled?: boolean;
  onSelect: () => void;
  onHighlight?: () => void;
}) {
  return (
    <button
      id={id}
      type="button"
      role={role}
      tabIndex={role === "option" ? -1 : undefined}
      aria-pressed={role ? undefined : checked}
      aria-checked={role === "menuitemradio" ? checked : undefined}
      aria-selected={role === "option" ? checked : undefined}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      className="pointer-events-auto absolute inset-0 rounded-lg hover:bg-content/[0.04] focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default disabled:hover:bg-transparent"
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={onHighlight}
      onClick={onSelect}
    />
  );
}

/**
 * One account in any account menu, a chat's or a Colleague's: its name, a
 * Ready / Running low / Exhausted label, its usage windows, and a way to
 * sign it in again once its sign-in expired. `removed` stands for an
 * account the conversation still names but that no longer exists.
 */
export function ProviderAccountRow({
  provider,
  accountId,
  label,
  limits,
  now,
  checked,
  removed = false,
  highlighted = false,
  subtitle,
  balanced,
  role,
  id,
  onSelect,
  onHighlight,
}: {
  provider: ProviderAccountProvider;
  accountId: string;
  label: string;
  limits: ProviderRateLimits | undefined;
  now: number;
  checked: boolean;
  removed?: boolean;
  /** The keyboard's place in a listbox. */
  highlighted?: boolean;
  /** Beside the name, as its plan and email. */
  subtitle?: ReactNode;
  /** Whether Balanced may use it; shown as a toggle when set. */
  balanced?: boolean;
  /** Unset for a plain button group. */
  role?: "menuitemradio" | "option";
  id?: string;
  onSelect: () => void;
  onHighlight?: () => void;
}) {
  const statusId = `${id ?? `account-${provider}-${accountId}`}-status`;
  const status = removed
    ? {
        tone: "unknown" as const,
        label: "This conversation uses a removed account",
        detail: null,
      }
    : accountStatus(limits, now);
  const meters = removed ? [] : meterWindows(limits);
  const expired = !removed && !!limits && needsProviderLogin(limits);
  return (
    <div className={rowClass(checked, highlighted)}>
      <RowTarget
        id={id}
        role={role}
        checked={checked}
        label={removed ? REMOVED_ACCOUNT_LABEL : label}
        describedBy={statusId}
        disabled={removed}
        onSelect={onSelect}
        onHighlight={onHighlight}
      />
      <span className="min-w-0 flex-1 py-0.5">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 truncate">
            {removed ? REMOVED_ACCOUNT_LABEL : label}
          </span>
          {subtitle}
        </span>
        <span className="mt-1 flex min-w-0 items-center gap-3 text-[10px]">
          <span
            id={statusId}
            // Without meters, a long "unknown" reason truncates.
            className={meters.length > 0 ? "shrink-0" : "min-w-0"}
          >
            <AccountStatusLabel status={status} className="min-w-0" />
          </span>
          {meters.length > 0 ? (
            <span className="flex min-w-0 flex-1 gap-2.5">
              {meters.map((entry) => (
                // Short "5h" / "wk" titles, as on the footer chip.
                <UsageMeter
                  key={entry.title}
                  title={formatWindowLabel(entry.window.windowMinutes)}
                  window={entry.window}
                  now={now}
                  className="min-w-0 flex-1"
                />
              ))}
            </span>
          ) : null}
        </span>
      </span>
      {balanced !== undefined && !removed ? (
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={balanced}
          aria-label={`Use ${label} in Balanced`}
          title={
            balanced
              ? "In the Balanced rotation · click to take it out"
              : "Not in the Balanced rotation · click to add it"
          }
          className={`pointer-events-auto relative h-5 shrink-0 rounded-md border px-1.5 text-[10px] leading-none transition-colors ${
            balanced
              ? "border-transparent bg-content/12 text-content/75 hover:bg-content/18"
              : "border-dashed border-content/20 text-content/35 hover:border-content/35 hover:text-content/60"
          }`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() =>
            setProviderAccountBalanced(provider, accountId, !balanced)
          }
        >
          Balanced
        </button>
      ) : null}
      {expired ? (
        <SignInAgainButton
          provider={provider}
          accountId={accountId}
          label={label}
          compact
          className="pointer-events-auto relative"
        />
      ) : null}
      {checked ? (
        <Check
          className="size-3.5 shrink-0 text-accent"
          strokeWidth={1.9}
          aria-hidden
        />
      ) : null}
    </div>
  );
}

/**
 * The Balanced choice above the accounts: the conversation runs on the one
 * with the most room and moves on, with its conversation, at a limit.
 */
export function BalancedAccountRow({
  pool,
  checked,
  currentLabel,
  highlighted = false,
  role,
  id,
  onSelect,
  onHighlight,
}: {
  /** The names of the accounts it spreads conversations over. */
  pool: readonly string[];
  checked: boolean;
  /** The account it runs on now, shown while Balanced is on. */
  currentLabel?: string;
  highlighted?: boolean;
  role?: "menuitemradio" | "option";
  id?: string;
  onSelect: () => void;
  onHighlight?: () => void;
}) {
  return (
    <div className={rowClass(checked, highlighted)}>
      <RowTarget
        id={id}
        role={role}
        checked={checked}
        label="Balanced"
        onSelect={onSelect}
        onHighlight={onHighlight}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1 py-0.5">
        <span>Balanced</span>
        <span className="text-[10px] leading-[13px] text-content/40">
          Between{" "}
          <span className="text-content/60">{balancedPoolLabel(pool)}</span>
          {" · "}runs on the most weekly room, moves on at a limit with its
          conversation
          {checked && currentLabel ? (
            <>
              {" · now on "}
              <span className="text-content/60">{currentLabel}</span>
            </>
          ) : null}
        </span>
      </span>
      {checked ? (
        <Check
          className="size-3.5 shrink-0 text-accent"
          strokeWidth={1.9}
          aria-hidden
        />
      ) : null}
    </div>
  );
}
