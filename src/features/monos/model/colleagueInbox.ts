import { remoteRequest } from "../../connections/model/connections";
import { homeWith } from "../../connections/model/homeCapability";
import type { RemoteMachine } from "../../connections/model/protocol";
import type { ProviderRateLimits } from "../../providers/model/rateLimits";
import { findMono, type MonoState } from "./mono";

/**
 * Messages written to a colleague in the browser app. Its chat runs on a
 * desktop, so the home machine's host keeps them until one takes them: this
 * desktop asks every few seconds, takes each one it can, and sends it to the
 * colleague as if it were typed here. A desktop that takes a message and
 * cannot send it lets it go back to the others after a minute.
 */

export type InboxMessage = {
  id: string;
  mono: string;
  text: string;
  /** A request to move the colleague to this account rather than a message. */
  account?: string;
  /** The conversation it goes to, or `new`; the open one when absent. */
  thread?: string;
  /** `stop` interrupts the turn; `steer` sends the text into it at once. */
  control?: "stop" | "steer";
  at: number;
};

/** What the phone sends to start a colleague's message in a new thread. */
export const MONO_NEW_THREAD = "new";

type Request = <T>(machine: RemoteMachine, method: string, params?: unknown) => Promise<T>;

/** Sends the text to the colleague's chat, or with `account` moves it to
 * that account; false when it could not yet. */
export type Deliver = (
  monoId: string,
  text: string,
  account?: string,
  thread?: string,
  control?: "stop" | "steer",
) => Promise<boolean>;

/** How much of a plan window is used, and when it starts over. */
export type ColleagueUsageWindow = { used: number; resetsAt: number | null };

export type ColleagueUsage = {
  session?: ColleagueUsageWindow;
  weekly?: ColleagueUsageWindow;
  updatedAt: number;
};

/** The accounts this desktop can move colleagues to with how much of each
 * is left, and every colleague's account and state. */
export type ColleagueAccounts = {
  accounts: {
    provider: string;
    id: string;
    label: string;
    usage?: ColleagueUsage;
    /** Why its usage could not be read, such as an expired sign-in. */
    error?: string;
    /** Balanced may use it. */
    balanced?: boolean;
  }[];
  current: Record<string, { provider: string; account: string; balanced?: boolean }>;
  status: Record<string, MonoState>;
  /** The state of each thread this desktop has open, by its id. */
  threads: Record<string, MonoState>;
};

/** An account's plan windows as the phone shows them; none until read once. */
export function colleagueUsage(limits: ProviderRateLimits): ColleagueUsage | undefined {
  if (!limits.updatedAt || (!limits.session && !limits.weekly)) return undefined;
  const window = (value: ProviderRateLimits["session"]) =>
    value ? { used: Math.round(value.usedPercent), resetsAt: value.resetsAt } : undefined;
  return {
    ...(limits.session ? { session: window(limits.session) } : {}),
    ...(limits.weekly ? { weekly: window(limits.weekly) } : {}),
    updatedAt: limits.updatedAt,
  };
}

const POLL_MS = 3_000;

/** One pass: every waiting message for a colleague this desktop has, in order. */
export async function deliverInbox(
  request: Request,
  home: RemoteMachine,
  by: string,
  deliver: Deliver,
  known: (monoId: string) => boolean = (id) => {
    const mono = findMono(id);
    return !!mono && !mono.localOnly;
  },
): Promise<number> {
  const waiting = await request<InboxMessage[]>(home, "employees.waiting");
  let sent = 0;
  // A colleague whose message could not go keeps its later ones waiting, so
  // they never arrive out of order.
  const held = new Set<string>();
  for (const message of waiting) {
    if (held.has(message.mono) || !known(message.mono)) continue;
    if (!(await request<boolean>(home, "employees.take", { id: message.id, by }))) {
      held.add(message.mono);
      continue;
    }
    const ok = await deliver(
      message.mono,
      message.text,
      message.account,
      message.thread,
      message.control,
    ).catch(() => false);
    if (!ok) {
      held.add(message.mono);
      continue;
    }
    await request(home, "employees.delivered", { id: message.id });
    sent++;
  }
  return sent;
}

/** How long the same accounts go unsent: a host restarted or updated in
 * the meantime may have dropped what it was told. */
const REPUBLISH_MS = 60_000;

/** Tells the home machine where colleagues can move, when that changed
 * since `last` or a minute went by. Returns what it last published. */
export async function publishAccounts(
  request: Request,
  home: RemoteMachine,
  accounts: ColleagueAccounts,
  last: { text: string; at: number } | undefined,
  now = Date.now(),
): Promise<{ text: string; at: number }> {
  const text = JSON.stringify(accounts);
  if (last && text === last.text && now - last.at < REPUBLISH_MS) return last;
  await request(home, "employees.setAccounts", accounts);
  return { text, at: now };
}

/** Runs while the app is open. */
export function startColleagueInbox(
  deliver: Deliver,
  accounts?: () => ColleagueAccounts,
): () => void {
  const request: Request = (machine, method, params) =>
    remoteRequest(machine.id, method, params);
  // Each window apart, so two windows of one desktop never both send it.
  const by = crypto.randomUUID();
  let running = false;
  let published: { text: string; at: number } | undefined;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const home = await homeWith("employees.inbox");
      if (home) await deliverInbox(request, home, by, deliver);
      const offers = accounts ? await homeWith("employees.accounts") : undefined;
      if (offers && accounts)
        published = await publishAccounts(request, offers, accounts(), published);
    } catch {
      // The host is out of reach: asked again on the next tick.
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), POLL_MS);
  return () => clearInterval(timer);
}
