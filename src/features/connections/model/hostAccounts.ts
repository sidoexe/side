import { useEffect, useState } from "react";
import { remoteRequest } from "./connections";
import type { HostAccountSummary, RemoteProvider } from "./protocol";

export const AUTO_HOST_ACCOUNT = "auto";
const cached = new Map<string, HostAccountSummary[]>();
const CHANGED = "side:host-accounts-changed";

/** Reads a host's accounts again, after one was added or signed in. */
export function reloadHostAccounts(machineId: string) {
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: machineId }));
}

/** Asks the host to read every account's usage now, then shows it. */
export async function refreshHostAccounts(machineId: string): Promise<void> {
  const value = await remoteRequest<HostAccountSummary[]>(machineId, "accounts.refresh");
  if (Array.isArray(value)) cached.set(machineId, value);
  reloadHostAccounts(machineId);
}

/** Puts a host account in the balanced pool or takes it out. */
export async function setHostAccountBalanced(
  machineId: string,
  accountId: string,
  balanced: boolean,
): Promise<void> {
  const value = await remoteRequest<HostAccountSummary[]>(machineId, "accounts.balance", {
    accountId,
    balanced,
  });
  if (Array.isArray(value)) cached.set(machineId, value);
  reloadHostAccounts(machineId);
}

/** Makes a host forget one of its accounts. */
export async function removeHostAccount(machineId: string, accountId: string): Promise<void> {
  const value = await remoteRequest<HostAccountSummary[]>(machineId, "accounts.remove", { accountId });
  if (Array.isArray(value)) cached.set(machineId, value);
  reloadHostAccounts(machineId);
}

/** Gives a host account a new name. */
export async function renameHostAccount(machineId: string, accountId: string, label: string): Promise<void> {
  const value = await remoteRequest<HostAccountSummary[]>(machineId, "accounts.rename", { accountId, label });
  if (Array.isArray(value)) cached.set(machineId, value);
  reloadHostAccounts(machineId);
}

const HIDDEN_DEFAULT_KEY = "side.hostDefaultHidden.v1";

/** Whether this desktop hides a host's own sign-in from its account picker. */
export function hostDefaultHidden(machineId: string, provider: RemoteProvider): boolean {
  try {
    const stored = JSON.parse(localStorage.getItem(HIDDEN_DEFAULT_KEY) ?? "{}") as Record<string, boolean>;
    return stored[`${machineId}:${provider}`] === true;
  } catch {
    return false;
  }
}

/** Hides or shows a host's own sign-in; the host's profile folder is left alone. */
export function setHostDefaultHidden(machineId: string, provider: RemoteProvider, hidden: boolean): void {
  let stored: Record<string, boolean> = {};
  try {
    stored = JSON.parse(localStorage.getItem(HIDDEN_DEFAULT_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    /* start again */
  }
  if (hidden) stored[`${machineId}:${provider}`] = true;
  else delete stored[`${machineId}:${provider}`];
  localStorage.setItem(HIDDEN_DEFAULT_KEY, JSON.stringify(stored));
  reloadHostAccounts(machineId);
}

/** The accounts a host offers, for hosts that advertise them. */
export function useHostAccounts(
  machineId: string,
  enabled: boolean,
): HostAccountSummary[] {
  const [accounts, setAccounts] = useState(() => cached.get(machineId) ?? []);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent<string>).detail === machineId) setReload((value) => value + 1);
    };
    window.addEventListener(CHANGED, changed);
    return () => window.removeEventListener(CHANGED, changed);
  }, [machineId]);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    void remoteRequest<HostAccountSummary[]>(machineId, "accounts.list")
      .then((value) => {
        if (disposed || !Array.isArray(value)) return;
        cached.set(machineId, value);
        setAccounts(value);
      })
      .catch(() => {
        /* the picker stays hidden; sessions use the default account */
      });
    return () => {
      disposed = true;
    };
  }, [machineId, enabled, reload]);
  return accounts;
}

export function accountsFor(
  accounts: readonly HostAccountSummary[],
  harness: RemoteProvider,
): HostAccountSummary[] {
  return accounts.filter((account) => account.provider === harness);
}

/** A new session on a host with balanced accounts starts balanced. */
export function defaultHostAccount(
  accounts: readonly HostAccountSummary[],
  harness: RemoteProvider,
): string | undefined {
  return accountsFor(accounts, harness).some((account) => account.id === AUTO_HOST_ACCOUNT)
    ? AUTO_HOST_ACCOUNT
    : undefined;
}
