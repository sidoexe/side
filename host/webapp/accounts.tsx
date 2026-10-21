import { useEffect, useRef, useState } from "react";
import { rpc } from "./api";
import { accountStatus, ago, limitedUntil, resetTime, type HostAccountSummary, type UsageWindow } from "./model";
import { useModel } from "./store";
import { Button, copyText, HarnessIcon, Icon, NavBar, Pill, SectionLabel, Spinner, Switch, type MenuItem } from "./ui";
import { Chip } from "./composer";

/** The account chip of a session, as the desktop's host account picker:
 * "Default" or a host account, each with its usage, and the accounts sheet. */
export function AccountChip({ machineId, harness, current, onChange }: { machineId: string; harness: string; current?: string; onChange: (id: string) => void }) {
  const model = useModel();
  const accounts = (model.machine(machineId)?.accounts ?? []).filter((account) => account.provider === harness);
  const selected = current && current !== "default" ? current : undefined;
  if (!accounts.length && !model.canSignIn(machineId, harness)) return null;
  const items = (): MenuItem[] => [
    { label: "Default", checked: !selected, run: () => onChange("default") },
    ...accounts.map(
      (account): MenuItem => ({
        label: account.label,
        checked: account.id === selected,
        detail: accountStatus(account, accounts) || undefined,
        run: () => onChange(account.id),
      }),
    ),
    { kind: "divider" },
    { label: "Accounts…", icon: "person", run: () => model.set({ sheet: { kind: "accounts", machineId, provider: harness } }) },
  ];
  return (
    <Chip
      label={accounts.find((account) => account.id === selected)?.label ?? "Default"}
      items={items}
      onOpen={() => void model.refreshAccounts(machineId)}
    />
  );
}

type SignIn = { machineId: string; provider: string; account?: HostAccountSummary };
type Found = { configDir: string; label: string };

/** The host's accounts: usage, sign-in errors, the Balanced pool, and
 * signing one in again or adding one, as the desktop's account menu. */
export function HostAccountsSheet({ machineId, provider, onDone, embedded }: { machineId: string; provider?: string; onDone: () => void; embedded?: boolean }) {
  const model = useModel();
  const [signIn, setSignIn] = useState<SignIn>();
  const [found, setFound] = useState<Found[]>([]);
  const [importing, setImporting] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const all = model.machine(machineId)?.accounts ?? [];
  const accounts = all.filter((account) => !provider || account.provider === provider);
  const claude = !provider || provider === "claude";
  const addable = ["claude", "codex"].filter((item) => (!provider || provider === item) && model.canSignIn(machineId, item));

  /** Signed-in Claude profiles no account declares yet, to import. */
  const loadFound = async () => {
    if (!claude || !model.can("accounts.import", machineId)) return;
    setFound(await rpc<Found[]>("accounts.found", {}, machineId).catch(() => []));
  };
  useEffect(() => {
    void model.refreshAccounts(machineId);
    void loadFound();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (signIn) return <HostSignIn {...signIn} onDone={() => setSignIn(undefined)} />;

  const adopt = async (entry: Found) => {
    setImporting(entry.configDir);
    try {
      await rpc("accounts.import", { configDir: entry.configDir }, machineId);
      setFound((list) => list.filter((item) => item.configDir !== entry.configDir));
      await model.refreshAccounts(machineId, true);
    } catch (error) {
      model.report(error);
    } finally {
      setImporting(undefined);
    }
  };

  const remove = (account: HostAccountSummary) =>
    model.set({
      dialog: {
        kind: "confirm",
        title: `Remove "${account.label}" from the host's accounts?`,
        action: "Remove",
        run: async () => {
          await model.changeAccounts(machineId, "accounts.remove", { accountId: account.id });
          await loadFound();
        },
      },
    });

  return (
    <>
      <NavBar
        sidebar
        title={model.multi() ? `${model.machine(machineId)?.name ?? "Host"} accounts` : "Host accounts"}
        back={embedded ? onDone : undefined}
        leading={
          model.can("accounts.refresh", machineId) && !embedded ? (
            <button
              className="bar-button"
              aria-label="Refresh"
              disabled={refreshing}
              onClick={async () => {
                setRefreshing(true);
                await model.refreshAccounts(machineId, true);
                setRefreshing(false);
              }}
            >
              {refreshing ? <Spinner size={16} /> : <Icon name="refresh" size={19} />}
            </button>
          ) : null
        }
        trailing={
          embedded ? null : (
            <button className="bar-text strong" onClick={onDone}>
              Done
            </button>
          )
        }
      />
      <div className="scroll sheet-scroll">
        <div className="accounts">
          {!accounts.length ? <p className="hint">No named accounts on this host. Sessions run on its own sign-in.</p> : null}
          {accounts.map((account) => (
            <AccountCard key={account.id} account={account} machineId={machineId} onSignIn={() => setSignIn({ machineId, provider: account.provider, account })} onRemove={() => remove(account)} />
          ))}
          {claude && model.can("accounts.import", machineId) && found.length ? (
            <>
              <SectionLabel text="Signed in on the host" />
              {found.map((entry) => (
                <button key={entry.configDir} className="card import" disabled={!!importing} onClick={() => void adopt(entry)}>
                  <Icon name="download" size={16} />
                  <span className="ellipsis">{importing === entry.configDir ? "Importing…" : `Import ${entry.label}`}</span>
                  <span className="spacer" />
                  <span className="mono-small faint ellipsis">{entry.configDir}</span>
                </button>
              ))}
            </>
          ) : null}
          {addable.length ? (
            <div className="button-row">
              {addable.map((item) => (
                <Button key={item} icon="plus" onClick={() => setSignIn({ machineId, provider: item })}>
                  {addable.length > 1 ? `Add ${item === "codex" ? "Codex" : "Claude"} account` : "Add account"}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

function AccountCard({ machineId, account, onSignIn, onRemove }: { machineId: string; account: HostAccountSummary; onSignIn: () => void; onRemove: () => void }) {
  const model = useModel();
  const until = limitedUntil(account);
  const updatedAt = account.usage?.updatedAt;
  return (
    <div className="card account">
      <div className="row-line">
        <HarnessIcon harness={account.provider} />
        <span className="strong ellipsis">{account.label}</span>
        <span className="spacer" />
        {account.usage?.error ? <Pill text="Sign-in needed" color="var(--del-fg)" /> : until ? <Pill text="Limited" /> : null}
      </div>
      {account.pool ? (
        <div className="meta muted">{accountStatus(account, model.machine(machineId)?.accounts ?? [])} · starts on the most weekly room, moves on at a limit</div>
      ) : (
        <>
          {account.usage?.fiveHour ? <WindowRow label="5h" window={account.usage.fiveHour} /> : null}
          {account.usage?.sevenDay ? <WindowRow label="7d" window={account.usage.sevenDay} /> : null}
          {until ? <div className="meta amber">Limited until {resetTime(until)}</div> : null}
          {account.usage?.error ? <div className="meta del clamp-3">{account.usage.error}</div> : null}
          {updatedAt ? <div className="meta faint">Updated {Date.now() - updatedAt < 60_000 ? "just now" : `${ago(updatedAt)} ago`}</div> : null}
          {account.balanced !== undefined && model.can("accounts.balance", machineId) ? (
            <div className="toggle-row">
              <div>
                <div className="small">Use in Balanced</div>
                <div className="meta faint">Balanced spreads conversations over these accounts</div>
              </div>
              <Switch
                on={account.balanced}
                label="Use in Balanced"
                onChange={(on) => void model.changeAccounts(machineId, "accounts.balance", { accountId: account.id, balanced: on })}
              />
            </div>
          ) : null}
          <div className="button-row">
            {model.canSignIn(machineId, account.provider) ? (
              <Button primary={!!account.usage?.error} onClick={onSignIn}>
                Sign in again
              </Button>
            ) : null}
            {model.can("accounts.remove", machineId) ? (
              <Button danger onClick={onRemove}>
                Remove
              </Button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

function WindowRow({ label, window }: { label: string; window: UsageWindow }) {
  const used = window.used ?? 0;
  return (
    <div className="window-row">
      <span className="mono-small faint window-label">{label}</span>
      <span className="bar grow">
        <span
          style={{
            width: `${Math.min(100, Math.max(0, used))}%`,
            background: used >= 90 ? "var(--del)" : used >= 75 ? "var(--amber)" : "var(--muted)",
          }}
        />
      </span>
      <span className="mono-small muted window-used">{Math.round(used)}%</span>
      {window.resetsAt && window.resetsAt > Date.now() ? <span className="meta faint ellipsis">resets {resetTime(window.resetsAt)}</span> : null}
    </div>
  );
}

type Step =
  | { kind: "starting" }
  | { kind: "code"; loginId: string; url: string }
  | { kind: "device"; loginId: string; url: string; userCode: string }
  | { kind: "failed"; message: string };

/** Signs a host account in from the browser. Claude: the host's
 * `claude auth login` offers a link, and the code the page shows goes back.
 * Codex: the host offers a link and a device code to enter there, and the
 * page waits for the host to see the sign-in through. */
function HostSignIn({ machineId, provider, account, onDone }: SignIn & { onDone: () => void }) {
  const model = useModel();
  const [step, setStep] = useState<Step>({ kind: "starting" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  /** Bumped on each start, so a stale poll stops. */
  const attempt = useRef(0);
  const finished = useRef(false);
  const loginId = useRef<string>(undefined);
  const providerName = provider === "codex" ? "Codex" : "Claude";

  const start = async () => {
    const current = ++attempt.current;
    setStep({ kind: "starting" });
    setCode("");
    setCopied(false);
    try {
      const started = await rpc<{ loginId: string; url: string; userCode?: string }>(
        "accounts.login",
        account ? { accountId: account.id, provider: account.provider } : { provider },
        machineId,
      );
      if (!started.url) throw new Error("The host offered no sign-in link");
      loginId.current = started.loginId;
      if (started.userCode) {
        setStep({ kind: "device", loginId: started.loginId, url: started.url, userCode: started.userCode });
        await copyText(started.userCode).then(() => setCopied(true), () => undefined);
        // Each `accounts.loginStatus` waits up to about 10 seconds on the host.
        while (current === attempt.current) {
          const status = await rpc<{ pending?: boolean; accountId?: string }>("accounts.loginStatus", { loginId: started.loginId }, machineId);
          if (current !== attempt.current) return;
          if (status.pending) continue;
          finished.current = true;
          await model.refreshAccounts(machineId, true);
          return onDone();
        }
      } else {
        setStep({ kind: "code", loginId: started.loginId, url: started.url });
      }
    } catch (error) {
      if (current === attempt.current) setStep({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  };

  useEffect(() => {
    void start();
    return () => {
      attempt.current += 1;
      // Leaving midway ends the host's sign-in, as the desktop does.
      if (!finished.current && loginId.current) void rpc("accounts.loginCancel", { loginId: loginId.current }, machineId).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = async () => {
    const value = code.trim();
    if (step.kind !== "code" || busy || !value) return;
    setBusy(true);
    try {
      await rpc("accounts.loginCode", { loginId: step.loginId, code: value }, machineId);
      finished.current = true;
      await model.refreshAccounts(machineId, true);
      onDone();
    } catch (error) {
      // The host ends the sign-in on a failed code; it starts over.
      setStep({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <NavBar sidebar title="Sign in" back={onDone} />
      <div className="scroll sheet-scroll">
        <div className="sign-in">
          <div className="sign-in-title">{account ? `Sign ${account.label} in again` : `Add a ${providerName} account`}</div>
          {step.kind === "starting" ? (
            <div className="row-line">
              <Spinner size={16} />
              <span className="small muted">Asking the host for a sign-in link…</span>
            </div>
          ) : step.kind === "code" ? (
            <>
              <p className="small muted">Sign in on the page that opens, then paste the code it shows here.</p>
              <a className="btn" href={step.url} target="_blank" rel="noreferrer noopener">
                <Icon name="external" size={14} />
                Open sign-in page
              </a>
              <form
                className="sign-in-code"
                onSubmit={(event) => {
                  event.preventDefault();
                  void finish();
                }}
              >
                <input
                  className="field mono"
                  value={code}
                  placeholder="Code"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(event) => setCode(event.target.value)}
                />
                <button className="btn primary" disabled={busy || !code.trim()}>
                  {busy ? "Signing in…" : "Sign in"}
                </button>
              </form>
            </>
          ) : step.kind === "device" ? (
            <>
              <p className="small muted">Open the sign-in page and enter this code there.</p>
              <button
                className="card device-code"
                aria-description="Copies the code"
                onClick={() => void copyText(step.userCode).then(() => setCopied(true))}
              >
                <span className="code">{step.userCode}</span>
                <span className="spacer" />
                <span className="meta muted row-line">
                  <Icon name={copied ? "check" : "copy"} size={13} />
                  {copied ? "Copied" : "Copy"}
                </span>
              </button>
              <a className="btn primary" href={step.url} target="_blank" rel="noreferrer noopener">
                <Icon name="external" size={14} />
                Open sign-in page
              </a>
              <div className="row-line">
                <Spinner size={14} />
                <span className="meta muted">Waiting for the sign-in to finish…</span>
              </div>
            </>
          ) : (
            <>
              <p className="small del">{step.message}</p>
              <div>
                <Button onClick={() => void start()}>Try again</Button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
