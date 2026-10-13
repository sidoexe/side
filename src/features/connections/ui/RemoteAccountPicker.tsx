import type { HostAccountSummary } from "../model/protocol";

const percent = (value?: number) => (value === undefined ? "" : `${Math.round(value)}%`);

function detail(account: HostAccountSummary): string {
  const usage = account.usage;
  if (!usage) return "";
  if (usage.blockedUntil && usage.blockedUntil > Date.now()) return " · limited";
  const parts = [
    usage.sevenDay ? `7d ${percent(usage.sevenDay.used)}` : "",
    usage.fiveHour ? `5h ${percent(usage.fiveHour.used)}` : "",
  ].filter(Boolean);
  return parts.length ? ` · ${parts.join(", ")}` : "";
}

/** Which host account a remote session runs on. */
export function RemoteAccountPicker({
  accounts,
  value,
  disabled,
  onChange,
}: {
  accounts: HostAccountSummary[];
  value: string | undefined;
  disabled?: boolean;
  onChange: (id: string | undefined) => void;
}) {
  if (!accounts.length) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-stroke px-4 py-1.5 text-[12px] text-content/55">
      <span>Account</span>
      <select
        aria-label="Host account"
        className="min-w-0 rounded-md border border-content/15 bg-content/3 px-2 py-0.5 text-[12px] text-content outline-none focus:border-content/35 disabled:opacity-50"
        value={value ?? "default"}
        disabled={disabled}
        onChange={(event) =>
          onChange(event.target.value === "default" ? undefined : event.target.value)
        }
      >
        <option value="default">Default account</option>
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.label}
            {detail(account)}
          </option>
        ))}
      </select>
    </div>
  );
}
