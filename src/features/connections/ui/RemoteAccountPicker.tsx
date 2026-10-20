import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  clampUsedPercent,
  formatResetDuration,
  formatUsagePercent,
  SESSION_WINDOW_MINUTES,
  WEEKLY_WINDOW_MINUTES,
  type RateLimitWindow,
} from "../../providers/model/rateLimits";
import { barClass, UsageMeter } from "../../providers/ui/ProviderAccountUsage";
import { useShowRemainingUsage } from "../../settings/model/displayPrefs";
import { HarnessIcon } from "../../sessions/ui/HarnessIcon";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowDownCircle, ArrowLeft, Check, Plus, Pencil, RefreshCw, RotateCcw, Trash2 } from "../../../shared/ui/icons";
import { Popover, type PopoverDismissReason } from "../../../shared/ui/Popover";
import { remoteRequest } from "../model/connections";
import {
  AUTO_HOST_ACCOUNT,
  refreshHostAccounts,
  reloadHostAccounts,
  removeHostAccount,
  renameHostAccount,
  hostDefaultHidden,
  setHostAccountBalanced,
  setHostDefaultHidden,
} from "../model/hostAccounts";
import type { HostAccountSummary, RemoteProvider } from "../model/protocol";
import { useRemoteAccountSlot } from "./remoteAccountSlot";

const DEFAULT = "default";
const DEFAULT_LABEL = "Default account";
const REMOVED_LABEL = "Removed account";

type Window = { key: string; label: string; used: number };

/** A window whose reset time has passed is empty again, whatever the host
 * last read. */
const live = (window: { used: number; resetsAt?: number } | undefined) =>
  window && window.resetsAt && window.resetsAt <= Date.now() ? { used: 0 } : window;

function windows(account: HostAccountSummary | undefined): Window[] {
  const usage = account?.usage;
  if (!usage) return [];
  const fiveHour = live(usage.fiveHour);
  const sevenDay = live(usage.sevenDay);
  return [
    fiveHour ? { key: "5h", label: "5h", used: fiveHour.used } : undefined,
    sevenDay ? { key: "7d", label: "7d", used: sevenDay.used } : undefined,
  ].filter((entry): entry is Window => !!entry);
}

const limited = (account: HostAccountSummary | undefined) =>
  !!account?.usage?.blockedUntil && account.usage.blockedUntil > Date.now();

function UsageText({ account }: { account: HostAccountSummary | undefined }) {
  const showRemaining = useShowRemainingUsage();
  if (limited(account)) return <span className="text-amber-600 dark:text-amber-300">limited</span>;
  if (account?.usage?.error && /sign/i.test(account.usage.error))
    return (
      <span className="text-red-600 dark:text-red-300" title={account.usage.error}>
        signed out
      </span>
    );
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

function meter(
  window: { used: number; resetsAt?: number } | undefined,
  windowMinutes: number,
  now: number,
): RateLimitWindow | undefined {
  if (!window) return undefined;
  const past = !!window.resetsAt && window.resetsAt <= now;
  return {
    usedPercent: past ? 0 : window.used,
    windowMinutes,
    resetsAt: past ? null : (window.resetsAt ?? null),
  };
}

/** One account in the menu: its name, then a bar per window with the time
 * left before it resets, as in Settings → Providers. */
function AccountUsageRows({ account, now }: { account: HostAccountSummary; now: number }) {
  const usage = account.usage;
  const blocked = usage?.blockedUntil && usage.blockedUntil > now ? usage.blockedUntil : undefined;
  if (blocked)
    return (
      <p className="text-[10px] leading-3 text-amber-600 dark:text-amber-300">
        Limited · free in {formatResetDuration(blocked - now)}
      </p>
    );
  const fiveHour = meter(usage?.fiveHour, SESSION_WINDOW_MINUTES, now);
  const sevenDay = meter(usage?.sevenDay, WEEKLY_WINDOW_MINUTES, now);
  return (
    <>
      {fiveHour || sevenDay ? (
        <div className="flex gap-3">
          {fiveHour ? (
            <UsageMeter title="5h" window={fiveHour} now={now} className="w-[7.5rem]" />
          ) : null}
          {sevenDay ? (
            <UsageMeter title="Weekly" window={sevenDay} now={now} className="w-[7.5rem]" />
          ) : null}
        </div>
      ) : usage?.error ? null : (
        <p className="text-[10px] leading-3 text-content/40">No usage read yet</p>
      )}
      {usage?.error ? (
        <p className="text-[10px] leading-3 text-red-600 dark:text-red-300">{usage.error}</p>
      ) : null}
    </>
  );
}

/** The names of the accounts the balanced choice uses, from hosts that
 * say which. */
function balancedOver(accounts: readonly HostAccountSummary[]): string | undefined {
  const pool = accounts.find((account) => account.id === AUTO_HOST_ACCOUNT)?.pool;
  if (!pool?.length) return undefined;
  return pool
    .map((id) => accounts.find((account) => account.id === id)?.label ?? id)
    .join(" and ")
    .replace(/ and (?=.* and )/g, ", ");
}

/** "just now", "4 min ago", for the newest reading among the accounts. */
function readAt(accounts: readonly HostAccountSummary[], now: number): string | undefined {
  const at = Math.max(0, ...accounts.map((account) => account.usage?.updatedAt ?? 0));
  if (!at) return undefined;
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "updated just now";
  if (minutes < 60) return `updated ${minutes} min ago`;
  return `updated ${formatResetDuration(now - at)} ago`;
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

/** On an account's row: whether the balanced choice uses it, its own
 * sign-in again, and removing it from the host. */
function AccountActions({
  account,
  canBalance,
  toggling,
  onToggleBalanced,
  onReconnect,
  onRename,
  onRemove,
}: {
  account: HostAccountSummary;
  canBalance: boolean;
  toggling: boolean;
  onToggleBalanced: () => void;
  onReconnect?: () => void;
  onRename?: () => void;
  onRemove?: () => void;
}) {
  const balanced = !!account.balanced;
  return (
    <span className="absolute right-1 top-1 flex items-center gap-0.5">
      {canBalance ? (
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={balanced}
          aria-label={`Use ${account.label} in Balanced`}
          title={balanced ? "In the Balanced rotation · click to take it out" : "Not in the Balanced rotation · click to add it"}
          disabled={toggling}
          className={`h-5 rounded-md border px-1.5 text-[10px] leading-none transition-colors disabled:opacity-50 ${
            balanced
              ? "border-transparent bg-content/12 text-content/75 hover:bg-content/18"
              : "border-dashed border-content/20 text-content/35 hover:border-content/35 hover:text-content/60"
          }`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onToggleBalanced}
        >
          Balanced
        </button>
      ) : null}
      {onReconnect ? (
        <button
          type="button"
          role="menuitem"
          aria-label={`Reconnect ${account.label}`}
          title={`Sign ${account.label} in again`}
          className={`grid size-5 place-items-center rounded-md hover:bg-content/10 hover:text-content ${
            account.usage?.error ? "text-amber-600 dark:text-amber-300" : "text-content/35"
          }`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onReconnect}
        >
          <RotateCcw className="size-3" strokeWidth={1.75} aria-hidden />
        </button>
      ) : null}
      {onRename ? (
        <button
          type="button"
          role="menuitem"
          aria-label={`Rename ${account.label}`}
          title="Rename account"
          disabled={toggling}
          className="grid size-5 place-items-center rounded-md text-content/35 hover:bg-content/10 hover:text-content disabled:opacity-50"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onRename}
        >
          <Pencil className="size-3" strokeWidth={1.75} aria-hidden />
        </button>
      ) : null}
      {onRemove ? (
        <button
          type="button"
          role="menuitem"
          aria-label={`Remove ${account.label}`}
          title={`Remove ${account.label} from the host`}
          disabled={toggling}
          className="grid size-5 place-items-center rounded-md text-content/35 hover:bg-content/10 hover:text-red-600 disabled:opacity-50 dark:hover:text-red-300"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onRemove}
        >
          <Trash2 className="size-3" strokeWidth={1.75} aria-hidden />
        </button>
      ) : null}
    </span>
  );
}

type LoginStep =
  | { kind: "starting" }
  | { kind: "code"; loginId: string; url: string; busy?: boolean; error?: string }
  | { kind: "device"; loginId: string; url: string; userCode: string }
  | { kind: "failed"; error: string };

const MENU_ITEM =
  "flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] leading-none text-content hover:bg-content/10";

const message = (error: unknown) => String(error).replace(/^Error: /, "");

/** How long to wait between asking how a Codex sign-in is going; the host
 * itself holds each question a few seconds. */
const DEVICE_POLL_MS = 1_000;

/** Signs a host account in from here: the host runs Claude's sign-in, this
 * computer opens its page, and the code it shows goes back to the host.
 * Codex's runs the other way: the host gives a code to enter on the page and
 * finishes by itself. */
function HostSignIn({
  machineId,
  provider,
  account,
  onBack,
  onDone,
}: {
  machineId: string;
  provider: RemoteProvider;
  /** The account to sign in again; none adds a new one. */
  account?: HostAccountSummary;
  onBack: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState<LoginStep>({ kind: "starting" });
  const [code, setCode] = useState("");
  const loginId = useRef<string | undefined>(undefined);
  const finished = useRef(false);

  useEffect(() => {
    let disposed = false;
    // Until the host says it is done, asks again how the device sign-in goes.
    const follow = async (id: string) => {
      while (!disposed) {
        const status = await remoteRequest<{ pending?: boolean }>(machineId, "accounts.loginStatus", {
          loginId: id,
        });
        if (disposed) return;
        if (!status?.pending) {
          finished.current = true;
          reloadHostAccounts(machineId);
          onDone();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, DEVICE_POLL_MS));
      }
    };
    void remoteRequest<{ loginId: string; url: string; userCode?: string }>(machineId, "accounts.login", {
      accountId: account?.id,
      ...(provider === "claude" ? {} : { provider }),
    })
      .then((started) => {
        loginId.current = started.loginId;
        if (disposed) return;
        void openUrl(started.url).catch(() => undefined);
        if (!started.userCode) {
          setStep({ kind: "code", loginId: started.loginId, url: started.url });
          return;
        }
        setStep({ kind: "device", loginId: started.loginId, url: started.url, userCode: started.userCode });
        return follow(started.loginId).catch((error) => {
          // The host's sign-in ended with the failure; the next try starts anew.
          finished.current = true;
          if (!disposed) setStep({ kind: "failed", error: message(error) });
        });
      })
      .catch((error) => {
        if (!disposed) setStep({ kind: "failed", error: message(error) });
      });
    return () => {
      disposed = true;
      // Leaving midway stops the sign-in on the host too.
      if (loginId.current && !finished.current)
        void remoteRequest(machineId, "accounts.loginCancel", {
          loginId: loginId.current,
        }).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId, provider, account?.id]);

  const submit = async () => {
    if (step.kind !== "code" || step.busy || !code.trim()) return;
    setStep({ ...step, busy: true, error: undefined });
    try {
      await remoteRequest(machineId, "accounts.loginCode", {
        loginId: step.loginId,
        code: code.trim(),
      });
      finished.current = true;
      reloadHostAccounts(machineId);
      onDone();
    } catch (error) {
      // The host's sign-in ends with a refused code; the next try starts anew.
      finished.current = true;
      setStep({ kind: "failed", error: message(error) });
    }
  };

  const name = provider === "codex" ? "Codex" : "Claude";
  const title = account ? `Reconnect ${account.label}` : `Add a ${name} account`;
  return (
    <div className="flex w-full min-w-0 flex-col gap-2 p-1.5 text-[12px] text-content">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label="Back"
          className="grid size-5 place-items-center rounded text-content/50 hover:bg-content/10 hover:text-content"
          onClick={onBack}
        >
          <ArrowLeft className="size-3.5" aria-hidden />
        </button>
        <span className="font-medium">{title}</span>
      </div>
      {step.kind === "starting" ? (
        <p className="text-content/55">Starting {name} sign-in on the host…</p>
      ) : step.kind === "failed" ? (
        <>
          <p role="alert" className="text-red-600 dark:text-red-300">
            {step.error}
          </p>
          <button
            type="button"
            className="self-start rounded-md px-2 py-1 text-content/70 hover:bg-content/8 hover:text-content"
            onClick={onBack}
          >
            Back
          </button>
        </>
      ) : step.kind === "device" ? (
        <div className="flex flex-col gap-2">
          <p className="text-content/55">
            Sign in to Codex in your browser and enter this code.{" "}
            <button
              type="button"
              className="text-content/75 underline underline-offset-2 hover:text-content"
              onClick={() => void openUrl(step.url).catch(() => undefined)}
            >
              Open the page again
            </button>
          </p>
          <p
            aria-label="Sign-in code"
            className="select-all self-start rounded-md border border-content/15 bg-content/3 px-2 py-1 font-mono text-[13px] tracking-wider text-content"
          >
            {step.userCode}
          </p>
          <p className="text-content/40">Waiting for the sign-in to finish…</p>
        </div>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <p className="text-content/55">
            Sign in to Claude in your browser, then paste the code it shows.{" "}
            <button
              type="button"
              className="text-content/75 underline underline-offset-2 hover:text-content"
              onClick={() => void openUrl(step.url).catch(() => undefined)}
            >
              Open the page again
            </button>
          </p>
          <input
            autoFocus
            aria-label="Sign-in code"
            placeholder="Paste code"
            spellCheck={false}
            autoComplete="off"
            className="h-7 w-full min-w-0 rounded-md border border-content/15 bg-content/3 px-2 font-mono text-[12px] text-content outline-none focus:border-content/35"
            value={code}
            disabled={step.busy}
            onChange={(event) => setCode(event.target.value)}
          />
          {step.error ? (
            <p role="alert" className="text-red-600 dark:text-red-300">
              {step.error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={step.busy || !code.trim()}
            className="h-7 self-end rounded-md bg-content px-3 text-[12px] font-medium text-background-base hover:bg-content/85 disabled:opacity-40"
          >
            {step.busy ? "Connecting…" : "Connect"}
          </button>
        </form>
      )}
    </div>
  );
}

type Found = { configDir: string; label: string };

/** Signed-in Claude profiles on the host that are not accounts yet, read
 * each time the menu opens. */
function useFoundAccounts(machineId: string, enabled: boolean) {
  const [found, setFound] = useState<Found[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    void remoteRequest<Found[]>(machineId, "accounts.found")
      .then((value) => {
        if (!disposed && Array.isArray(value)) setFound(value);
      })
      .catch(() => {
        /* nothing to offer */
      });
    return () => {
      disposed = true;
    };
  }, [machineId, enabled]);
  return [found, setFound] as const;
}

/** Which host account a remote session runs on, in the app footer where
 * this computer's usage chips would be. */
export function RemoteAccountPicker({
  sessionId,
  machineId,
  harness,
  canSignIn = false,
  canSignInCodex = false,
  canImport = false,
  canRefresh = false,
  canBalance = false,
  canRemove = false,
  canRename = false,
  accounts,
  value,
  disabled,
  onChange,
}: {
  sessionId: string;
  machineId: string;
  harness: RemoteProvider;
  /** The host can sign its Claude accounts in from here. */
  canSignIn?: boolean;
  /** The host can sign its Codex accounts in too, with a device code. */
  canSignInCodex?: boolean;
  /** The host offers its signed-in profiles that are not accounts yet. */
  canImport?: boolean;
  /** The host can read its accounts' usage on demand. */
  canRefresh?: boolean;
  /** The host can put accounts in the balanced pool and take them out. */
  canBalance?: boolean;
  /** The host can forget one of its accounts. */
  canRemove?: boolean;
  /** The host can rename its accounts. */
  canRename?: boolean;
  accounts: HostAccountSummary[];
  value: string | undefined;
  disabled?: boolean;
  onChange: (id: string | undefined) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"menu" | { signIn: HostAccountSummary | undefined }>("menu");
  const slot = useRemoteAccountSlot(sessionId);
  const signIn = canSignIn && (harness === "claude" || (harness === "codex" && canSignInCodex));
  const [found, setFound] = useFoundAccounts(machineId, open && canImport && harness === "claude");
  const [importing, setImporting] = useState<string>();
  const [importError, setImportError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [toggling, setToggling] = useState<string>();
  const [balanceError, setBalanceError] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const [, setHiddenVersion] = useState(0);
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refreshHostAccounts(machineId);
    } catch {
      /* the last levels stay; each account says why it could not be read */
    } finally {
      setNow(Date.now());
      setRefreshing(false);
    }
  };
  // Opening the menu reads the levels afresh; the host reuses a reading
  // taken in the last few seconds.
  useEffect(() => {
    if (!open || !canRefresh) return;
    setNow(Date.now());
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, canRefresh, machineId]);
  if ((!accounts.length && !signIn) || !slot) return null;
  const selected = value ?? DEFAULT;
  const active = accounts.find((account) => account.id === selected);
  // A named account the host no longer lists: removed there.
  const removed = selected !== DEFAULT && selected !== AUTO_HOST_ACCOUNT && !active && accounts.length > 0;
  const activeLabel = active?.label ?? (removed ? REMOVED_LABEL : DEFAULT_LABEL);
  const provider = harness;
  const named = accounts.filter((account) => account.id !== AUTO_HOST_ACCOUNT);
  // Hidden only while a named account is there to run on instead.
  const defaultHidden = hostDefaultHidden(machineId, harness) && named.length > 0;
  const options = [
    ...accounts.map((account) => ({
      id: account.id,
      label: account.label,
      account: account.id === AUTO_HOST_ACCOUNT ? undefined : account,
    })),
    ...(defaultHidden && selected !== DEFAULT
      ? []
      : [{ id: DEFAULT, label: DEFAULT_LABEL, account: undefined }]),
  ];

  const adopt = async (entry: Found) => {
    if (importing) return;
    setImporting(entry.configDir);
    setImportError(undefined);
    try {
      await remoteRequest(machineId, "accounts.import", { configDir: entry.configDir });
      setFound((current) => current.filter((other) => other.configDir !== entry.configDir));
      reloadHostAccounts(machineId);
    } catch (error) {
      setImportError(message(error));
    } finally {
      setImporting(undefined);
    }
  };

  const toggleBalanced = async (account: HostAccountSummary) => {
    if (toggling) return;
    setToggling(account.id);
    setBalanceError(undefined);
    try {
      await setHostAccountBalanced(machineId, account.id, !account.balanced);
    } catch (error) {
      setBalanceError(message(error));
    } finally {
      setToggling(undefined);
    }
  };

  const rename = async (account: HostAccountSummary) => {
    if (toggling) return;
    const label = window.prompt(`Rename “${account.label}”`, account.label)?.trim();
    if (!label || label === account.label) return;
    setToggling(account.id);
    setBalanceError(undefined);
    try {
      await renameHostAccount(machineId, account.id, label);
    } catch (error) {
      setBalanceError(message(error));
    } finally {
      setToggling(undefined);
    }
  };

  const removeDefault = () => {
    if (
      !window.confirm(
        `Remove the host's own ${harness === "codex" ? "Codex" : "Claude"} sign-in from this list? The host keeps it, and conversations still on it keep running.`,
      )
    )
      return;
    setHostDefaultHidden(machineId, harness, true);
    setHiddenVersion((value) => value + 1);
  };

  const remove = async (account: HostAccountSummary) => {
    if (toggling) return;
    if (
      !window.confirm(
        `Remove “${account.label}” from the host? Conversations on it stay, but cannot continue until you switch accounts. Its profile folder stays on the host.`,
      )
    )
      return;
    setToggling(account.id);
    setBalanceError(undefined);
    try {
      await removeHostAccount(machineId, account.id);
    } catch (error) {
      setBalanceError(message(error));
    } finally {
      setToggling(undefined);
    }
  };

  const dismiss = (reason: PopoverDismissReason) => {
    setOpen(false);
    setView("menu");
    setImportError(undefined);
    setBalanceError(undefined);
    if (reason === "escape") requestAnimationFrame(() => trigger.current?.focus());
  };

  return createPortal(
    <>
      <button
        ref={trigger}
        type="button"
        className="-mx-1 inline-flex h-5 min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-1 text-content/55 transition-[background-color,color,transform] duration-150 ease-out hover:bg-content/10 hover:text-content focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50"
        aria-label={`Host account: ${activeLabel}`}
        aria-expanded={open}
        aria-haspopup="menu"
        title={
          removed
            ? "This conversation uses a removed account; choose another one"
            : "Account this conversation runs on, on the host"
        }
        disabled={disabled}
        onClick={() => {
          setOpen((current) => !current);
          setView("menu");
        }}
      >
        <HarnessIcon harness={provider} className="size-3 shrink-0" />
        <span className={`max-w-32 truncate ${removed ? "text-amber-600 dark:text-amber-300" : "text-content/45"}`}>
          {activeLabel}
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
          role={typeof view === "object" ? "dialog" : "menu"}
          aria-label={typeof view === "object" ? "Sign in a host account" : "Host accounts"}
          className="w-[18.5rem] p-1"
        >
          {typeof view === "object" ? (
            <HostSignIn
              machineId={machineId}
              provider={provider}
              account={view.signIn}
              onBack={() => setView("menu")}
              onDone={() => {
                setOpen(false);
                setView("menu");
              }}
            />
          ) : (
          <>
          <div className="flex h-7 items-center gap-2 pl-2 pr-0.5 text-[11px] text-content/40">
            <span className="min-w-0 flex-1 truncate">
              Host accounts{readAt(named, now) ? ` · ${readAt(named, now)}` : ""}
            </span>
            {!canRefresh ? (
              <span
                className="shrink-0 pr-1.5 text-content/35"
                title="This host is too old to read usage on demand. Update it in Settings → Connections."
              >
                Update host to refresh
              </span>
            ) : (
              <button
                type="button"
                aria-label="Refresh usage"
                title="Read every account's usage now"
                disabled={refreshing}
                className="grid size-6 place-items-center rounded-md text-content/40 hover:bg-content/10 hover:text-content disabled:opacity-40"
                onClick={() => void refresh()}
              >
                <RefreshCw
                  className={`size-3 ${refreshing ? "animate-spin" : ""}`}
                  strokeWidth={1.75}
                  aria-hidden
                />
              </button>
            )}
          </div>
          {options.map((option) => (
            <div key={option.id} className="relative">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={option.id === selected}
                className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] leading-none text-content hover:bg-content/10"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setOpen(false);
                  if (option.id !== selected)
                    onChange(option.id === DEFAULT ? undefined : option.id);
                }}
              >
                <span className="grid size-3 shrink-0 place-items-center pt-px">
                  {option.id === selected ? (
                    <Check className="size-3" strokeWidth={2} aria-hidden />
                  ) : null}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className={`truncate ${option.account ? (canRemove ? "pr-28" : "pr-24") : ""}`}>
                    {option.label}
                  </span>
                  {option.id === AUTO_HOST_ACCOUNT ? (
                    <span className="text-[10px] leading-[13px] text-content/40">
                      {balancedOver(accounts) ? (
                        <>
                          Between <span className="text-content/60">{balancedOver(accounts)}</span>
                          {" · "}
                        </>
                      ) : null}
                      starts on the most weekly room, moves on at a limit
                    </span>
                  ) : option.account ? (
                    <AccountUsageRows account={option.account} now={now} />
                  ) : (
                    <span className="text-[10px] leading-3 text-content/40">
                      The host's own Claude sign-in
                    </span>
                  )}
                </span>
              </button>
              {option.account ? (
                <AccountActions
                  account={option.account}
                  canBalance={canBalance}
                  toggling={toggling === option.account.id}
                  onToggleBalanced={() => void toggleBalanced(option.account!)}
                  onReconnect={signIn ? () => setView({ signIn: option.account }) : undefined}
                  onRename={canRename ? () => void rename(option.account!) : undefined}
                  onRemove={canRemove ? () => void remove(option.account!) : undefined}
                />
              ) : option.id === DEFAULT && named.length > 0 ? (
                <span className="absolute right-1 top-1 flex items-center gap-0.5">
                  <button
                    type="button"
                    role="menuitem"
                    aria-label={`Remove ${option.label}`}
                    title="Remove from this list"
                    className="grid size-5 place-items-center rounded-md text-content/35 hover:bg-content/10 hover:text-red-600 dark:hover:text-red-300"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={removeDefault}
                  >
                    <Trash2 className="size-3" strokeWidth={1.75} aria-hidden />
                  </button>
                </span>
              ) : null}
            </div>
          ))}
          {balanceError ? (
            <p role="alert" className="px-2 py-1 text-[11px] text-red-600 dark:text-red-300">
              {balanceError}
            </p>
          ) : null}
          {found.length ? (
            <>
              <div role="separator" className="my-1 h-px bg-content/10" />
              <div className="px-2 pb-0.5 pt-1 text-[11px] text-content/40">
                Signed in on the host
              </div>
              {found.map((entry) => (
                <button
                  key={entry.configDir}
                  type="button"
                  role="menuitem"
                  className={MENU_ITEM}
                  title={`Add ${entry.configDir} as an account`}
                  disabled={!!importing}
                  onClick={() => void adopt(entry)}
                >
                  <ArrowDownCircle className="size-3 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">
                    {importing === entry.configDir ? "Importing…" : `Import ${entry.label}`}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-content/35">
                    {entry.configDir}
                  </span>
                </button>
              ))}
              {importError ? (
                <p role="alert" className="px-2 py-1 text-[11px] text-red-600 dark:text-red-300">
                  {importError}
                </p>
              ) : null}
            </>
          ) : null}
          {signIn ? (
            <>
              <div role="separator" className="my-1 h-px bg-content/10" />
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM}
                onClick={() => setView({ signIn: undefined })}
              >
                <Plus className="size-3 shrink-0" aria-hidden />
                <span>Add account…</span>
              </button>
            </>
          ) : null}
          </>
          )}
        </Popover>
      ) : null}
    </>,
    slot,
  );
}
