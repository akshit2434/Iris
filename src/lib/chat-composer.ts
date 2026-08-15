export function canSubmitMessage(content: string, sending: boolean, presentationActive: boolean, hasThread: boolean) {
  return Boolean(content.trim()) && hasThread && !sending && !presentationActive;
}
