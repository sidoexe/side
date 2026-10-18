import { sameProviderAccountId } from "../../providers/model/providerAccounts";
import type { Session } from "./session";

/**
 * Move a conversation to another account of its provider. Provider threads
 * are account-owned, so the next turn opens a fresh one and hands the
 * transcript over.
 */
export function switchSessionAccount(
  session: Session,
  accountId: string,
): Session {
  if (
    session.busy ||
    sameProviderAccountId(session.providerAccountId, accountId)
  )
    return session;
  if (!session.blocks.some((block) => block.role === "user"))
    return {
      ...session,
      providerAccountId: accountId,
      providerSessionId: undefined,
    };
  return {
    ...session,
    providerAccountId: accountId,
    providerSessionId: undefined,
    pendingSwitch: {
      ...(session.pendingSwitch ?? {
        from: session.harness,
        fromModel: session.model,
        fromSettings: session.modelSettings,
        fromProviderSessionId: session.providerSessionId,
        fromProviderAccountId: session.providerAccountId,
      }),
      skipOutgoingRecap: true,
    },
  };
}

/**
 * A Claude conversation whose transcript was copied into the new account
 * resumes there, with nothing lost to a recap.
 */
export function canCarrySessionAccount(session: Session): boolean {
  return (
    session.harness === "claude" &&
    !!session.providerSessionId &&
    !session.pendingSwitch &&
    !session.busy
  );
}

/** Move a conversation to an account that already holds its transcript. */
export function carrySessionAccount(
  session: Session,
  accountId: string,
): Session {
  if (
    !canCarrySessionAccount(session) ||
    sameProviderAccountId(session.providerAccountId, accountId)
  )
    return session;
  return { ...session, providerAccountId: accountId };
}
