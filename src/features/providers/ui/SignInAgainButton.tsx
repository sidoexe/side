import { useState } from "react";
import { signInProviderAccount } from "../model/providerSignIn";
import type { ProviderAccountProvider } from "../model/providerAccounts";
import { Loader, RotateCcw } from "../../../shared/ui/icons";

/** Signs an account whose sign-in expired in again, where it is listed. */
export function SignInAgainButton({
  provider,
  accountId,
  label,
  compact = false,
  className = "",
}: {
  provider: ProviderAccountProvider;
  accountId: string;
  /** The account's name, for the button's label. */
  label: string;
  /** Icon only, for a tight row. */
  compact?: boolean;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      aria-label={`Sign ${label} in again`}
      title="Opens the provider's sign-in in your browser"
      className={`inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-700 transition-colors hover:bg-amber-500/20 disabled:opacity-60 dark:text-amber-300 ${
        compact ? "size-6 justify-center" : "h-6 px-2 text-[11px]"
      } ${className}`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation();
        setBusy(true);
        void signInProviderAccount(provider, accountId)
          .catch(() => undefined)
          .finally(() => setBusy(false));
      }}
    >
      {busy ? (
        <Loader className="size-3 animate-spin" aria-hidden />
      ) : (
        <RotateCcw className="size-3" strokeWidth={1.75} aria-hidden />
      )}
      {compact ? null : busy ? "Signing in…" : "Sign in again"}
    </button>
  );
}
