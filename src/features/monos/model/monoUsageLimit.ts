import { CONTINUE_PROMPT } from "../../sessions/model/inFlight";
import type { Session } from "../../sessions/model/session";
import { sameProviderAccountId } from "../../providers/model/providerAccounts";
import { resumeUsageLimitedSession } from "../../sessions/model/usageLimit";
import {
  canCarrySessionAccount,
  carrySessionAccount,
  switchSessionAccount,
} from "../../sessions/model/accountSwitch";
import { enqueueMonoMessage } from "./monoMessaging";

/** Retry the existing outbox in order, or continue the stopped work once. */
export function resumeMonoUsageLimit(session: Session): Session {
  if (!session.usageLimit || session.busy) return session;
  const resumed = resumeUsageLimitedSession(session);
  return resumed.queuedMessages?.length
    ? resumed
    : enqueueMonoMessage(resumed, {
        id: crypto.randomUUID(),
        text: CONTINUE_PROMPT,
        attachments: [],
      });
}

/** Move a Mono to another account, handing its transcript over. */
export const switchMonoAccount = switchSessionAccount;

/** Account-owned threads need a fresh connection with a transcript handoff. */
export function switchMonoUsageLimitAccount(
  session: Session,
  accountId: string,
): Session {
  if (
    !session.usageLimit ||
    session.busy ||
    sameProviderAccountId(session.providerAccountId, accountId)
  )
    return session;
  return resumeMonoUsageLimit(switchMonoAccount(session, accountId));
}

/** A Claude Mono resumes its own conversation on the new account. */
export const canCarryMonoAccount = canCarrySessionAccount;

/** Move a Mono to an account that already holds a copy of its transcript. */
export function carryMonoAccount(session: Session, accountId: string): Session {
  const moved = carrySessionAccount(session, accountId);
  return moved !== session && moved.usageLimit
    ? resumeMonoUsageLimit(moved)
    : moved;
}
