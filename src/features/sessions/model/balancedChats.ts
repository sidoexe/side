const BALANCED_CHATS_KEY = "monocode.balancedChats.v1";
const CHANGE_EVENT = "monocode-balanced-chats-changed";

/**
 * Chats set to Balanced, by session id. A Colleague keeps the same choice
 * on itself; a chat keeps it here, beside its stored conversation.
 */
export function balancedChatIds(): string[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(BALANCED_CHATS_KEY) ?? "[]",
    );
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

export function saveChatBalanced(sessionId: string, balanced: boolean): void {
  const ids = balancedChatIds().filter((id) => id !== sessionId);
  try {
    localStorage.setItem(
      BALANCED_CHATS_KEY,
      JSON.stringify(balanced ? [...ids, sessionId] : ids),
    );
  } catch {
    return;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** The snapshot `useSyncExternalStore` compares. */
export function balancedChatsSnapshot(): string {
  try {
    return localStorage.getItem(BALANCED_CHATS_KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

export function subscribeBalancedChats(listener: () => void): () => void {
  const storage = (event: StorageEvent) => {
    if (event.key === BALANCED_CHATS_KEY || event.key === null) listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", storage);
  };
}
