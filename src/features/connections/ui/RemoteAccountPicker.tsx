import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { clampUsedPercent, formatUsagePercent } from "../../providers/model/rateLimits";
import { barClass } from "../../providers/ui/ProviderAccountUsage";
import { useShowRemainingUsage } from "../../settings/model/displayPrefs";
import { HarnessIcon } from "../../sessions/ui/HarnessIcon";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, Check, Plus, RefreshCw } from "../../../shared/ui/icons";
import { Popover, type PopoverDismissReason } from "../../../shared/ui/Popover";
import { remoteRequest } from "../model/connections";
import { AUTO_HOST_ACCOUNT, reloadHostAccounts } from "../model/hostAccounts";
import type { HostAccountSummary, RemoteProvider } from "../model/protocol";
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

type LoginStep =
  | { kind: "starting" }
  | { kind: "code"; loginId: string; url: string; busy?: boolean; error?: string }
  | { kind: "failed"; error: string };

const MENU_ITEM =
  "flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] leading-none text-content hover:bg-content/10";

const message = (error: unknown) => String(error).replace(/^Error: /, "");

/** Signs a host account in from here: the host runs Claude's sign-in, this
 * computer opens its page, and the code it shows goes back to the host. */
function HostSignIn({
  machineId,
  account,
  onBack,
  onDone,
}: {
  machineId: string;
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
    void remoteRequest<{ loginId: string; url: string }>(machineId, "accounts.login", {
      accountId: account?.id,
    })
      .then((started) => {
        loginId.current = started.loginId;
        if (disposed) return;
        setStep({ kind: "code", loginId: started.loginId, url: started.url });
        void openUrl(started.url).catch(() => undefined);
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
  }, [machineId, account?.id]);

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

  const title = account ? `Reconnect ${account.label}` : "Add a Claude account";
  return (
    <div className="flex w-[19rem] flex-col gap-2 p-1.5 text-[12px] text-content">
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
        <p className="text-content/55">Starting Claude sign-in on the host…</p>
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
            className="h-7 rounded-md border border-content/15 bg-content/3 px-2 font-mono text-[12px] outline-none focus:border-content/35"
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
            className="h-7 self-end rounded-md bg-content px-3 text-[12px] font-medium text-surface hover:opacity-90 disabled:opacity-40"
          >
            {step.busy ? "Connecting…" : "Connect"}
          </button>
        </form>
      )}
    </div>
  );
}

/** Which host account a remote session runs on, in the app footer where
 * this computer's usage chips would be. */
export function RemoteAccountPicker({
  sessionId,
  machineId,
  harness,
  canSignIn = false,
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
  accounts: HostAccountSummary[];
  value: string | undefined;
  disabled?: boolean;
  onChange: (id: string | undefined) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<
    "menu" | "reconnect" | { signIn: HostAccountSummary | undefined }
  >("menu");
  const slot = useRemoteAccountSlot(sessionId);
  const signIn = canSignIn && harness === "claude";
  if ((!accounts.length && !signIn) || !slot) return null;
  const selected = value ?? DEFAULT;
  const active = accounts.find((account) => account.id === selected);
  const provider = harness;
  const named = accounts.filter((account) => account.id !== AUTO_HOST_ACCOUNT);
  const options = [
    ...accounts.map((account) => ({ id: account.id, label: account.label, account })),
    { id: DEFAULT, label: DEFAULT_LABEL, account: undefined },
  ];

  const dismiss = (reason: PopoverDismissReason) => {
    setOpen(false);
    setView("menu");
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
        onClick={() => {
          setOpen((current) => !current);
          setView("menu");
        }}
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
          role={typeof view === "object" ? "dialog" : "menu"}
          aria-label={typeof view === "object" ? "Sign in a host account" : "Host accounts"}
          className="min-w-[15rem] p-1"
        >
          {typeof view === "object" ? (
            <HostSignIn
              machineId={machineId}
              account={view.signIn}
              onBack={() => setView("menu")}
              onDone={() => {
                setOpen(false);
                setView("menu");
              }}
            />
          ) : view === "reconnect" ? (
            <>
              <button
                type="button"
                className={`${MENU_ITEM} text-content/60`}
                onClick={() => setView("menu")}
              >
                <ArrowLeft className="size-3 shrink-0" aria-hidden />
                <span>Reconnect an account</span>
              </button>
              {named.map((account) => (
                <button
                  key={account.id}
                  type="button"
                  role="menuitem"
                  className={MENU_ITEM}
                  onClick={() => setView({ signIn: account })}
                >
                  <span className="size-3 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{account.label}</span>
                </button>
              ))}
            </>
          ) : (
          <>
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
              {named.length ? (
                <button
                  type="button"
                  role="menuitem"
                  className={MENU_ITEM}
                  onClick={() =>
                    setView(named.length === 1 ? { signIn: named[0] } : "reconnect")
                  }
                >
                  <RefreshCw className="size-3 shrink-0" aria-hidden />
                  <span>Reconnect…</span>
                </button>
              ) : null}
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
