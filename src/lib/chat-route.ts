export const UNSAVED_CHAT_ID = "new";

export function isUnsavedChatPath(pathname: string) {
  return pathname === "/chat/new";
}

export function isNewChatPromotion(previousThreadId: string, nextThreadId: string) {
  return previousThreadId === UNSAVED_CHAT_ID && isPersistedThreadId(nextThreadId);
}

/** A route-shaped ID is not enough to preserve the provisional chat state.
 * Confirm that it is the thread created by this first-message request. */
export function isConfirmedNewChatPromotion(previousThreadId: string, nextThreadId: string, createdThreadId: string | null) {
  return isNewChatPromotion(previousThreadId, nextThreadId) && createdThreadId === nextThreadId;
}

export function messageEndpointForThread(threadId: string) {
  return threadId === UNSAVED_CHAT_ID
    ? "/api/threads/new/messages"
    : `/api/threads/${threadId}/messages`;
}

export function isPersistedThreadId(value: string | null): value is string {
  return value !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
