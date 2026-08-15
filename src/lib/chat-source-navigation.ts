const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function messageIdFromHash(hash: string) {
  const match = /^#message-([0-9a-f-]+)$/i.exec(hash);
  return match && UUID_PATTERN.test(match[1]) ? match[1] : null;
}

export function resolveMessageHashTarget(hash: string, messageIds: readonly string[]) {
  const messageId = messageIdFromHash(hash);
  return messageId && messageIds.includes(messageId) ? messageId : null;
}
