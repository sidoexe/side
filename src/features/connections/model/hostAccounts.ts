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
