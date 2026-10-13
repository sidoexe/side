import { useEffect, useState } from "react";
import { remoteRequest } from "./connections";
import type { HostAccountSummary, RemoteProvider } from "./protocol";

export const AUTO_HOST_ACCOUNT = "auto";
const cached = new Map<string, HostAccountSummary[]>();

/** The accounts a host offers, for hosts that advertise them. */
export function useHostAccounts(
  machineId: string,
  enabled: boolean,
): HostAccountSummary[] {
  const [accounts, setAccounts] = useState(() => cached.get(machineId) ?? []);
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
  }, [machineId, enabled]);
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
