export const UNSAVED_CHAT_ID = "new";

export function isUnsavedChatPath(pathname: string) {
  return pathname === "/chat/new";
}

export function isNewChatPromotion(previousThreadId: string, nextThreadId: string) {
  return previousThreadId === UNSAVED_CHAT_ID && isPersistedThreadId(nextThreadId);
}

export function messageEndpointForThread(threadId: string) {
  return threadId === UNSAVED_CHAT_ID
    ? "/api/threads/new/messages"
    : `/api/threads/${threadId}/messages`;
}

export function isPersistedThreadId(value: string | null): value is string {
  return value !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
