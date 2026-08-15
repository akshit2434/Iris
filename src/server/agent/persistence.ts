export function planAssistantPersistence(input: {
  content: string;
  failed: boolean;
}) {
  const content = input.content;
  if (content.length === 0) {
    return null;
  }

  return {
    content,
    isComplete: !input.failed,
  };
}
