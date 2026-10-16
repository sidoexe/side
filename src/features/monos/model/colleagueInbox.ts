import { remoteRequest } from "../../connections/model/connections";
import { homeWith } from "../../connections/model/homeCapability";
import type { RemoteMachine } from "../../connections/model/protocol";
import { findMono } from "./mono";

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
  at: number;
};

type Request = <T>(machine: RemoteMachine, method: string, params?: unknown) => Promise<T>;

/** Sends the text to the colleague's chat, or with `account` moves it to
 * that account; false when it could not yet. */
export type Deliver = (monoId: string, text: string, account?: string) => Promise<boolean>;

/** The accounts this desktop can move colleagues to, and each one's current. */
export type ColleagueAccounts = {
  accounts: { provider: string; id: string; label: string }[];
  current: Record<string, { provider: string; account: string }>;
};

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
    const ok = await deliver(message.mono, message.text, message.account).catch(() => false);
    if (!ok) {
      held.add(message.mono);
      continue;
    }
    await request(home, "employees.delivered", { id: message.id });
    sent++;
  }
  return sent;
}

/** Tells the home machine where colleagues can move, when that changed
 * since `last`. Returns what it last published. */
export async function publishAccounts(
  request: Request,
  home: RemoteMachine,
  accounts: ColleagueAccounts,
  last: string | undefined,
): Promise<string> {
  const text = JSON.stringify(accounts);
  if (text !== last) await request(home, "employees.setAccounts", accounts);
  return text;
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
  let published: string | undefined;
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
