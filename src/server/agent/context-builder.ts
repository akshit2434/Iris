import type { Message } from "@/lib/types";
import type { CanonicalMemoryContext } from "@/server/memory/context-budget";

export type AgentContextMessage = Pick<Message, "role" | "content" | "isComplete"> & { id?: string };
export type AgentMessage = AgentContextMessage;

export type ThreadAgentContext = {
  rawHistory: {
    messages: AgentContextMessage[];
  };
  continuity: {
    summary: string | null;
    pinnedNotes: string[];
    continuityThroughMessageId: string | null;
    continuityThroughCreatedAt: string | null;
    continuityRevision: number;
  };
  futureMemory: {
    global: CanonicalMemoryContext["items"];
    thread: readonly [];
    globalRevision: number;
  };
};

export function buildThreadAgentContext(input: {
  messages: AgentContextMessage[];
  continuitySummary?: string | null;
  pinnedNotes?: string[];
  continuityThroughMessageId?: string | null;
  continuityThroughCreatedAt?: string | null;
  continuityRevision?: number;
  canonicalMemory?: CanonicalMemoryContext;
}): ThreadAgentContext {
  // Keep the complete raw tail until a usable continuity summary exists. This
  // boundary deliberately does not summarize, retrieve, or compact history.
  return {
    rawHistory: {
      messages: input.messages.map((message) => ({
        ...(message.id ? { id: message.id } : {}),
        role: message.role,
        content: message.content,
        isComplete: message.isComplete,
      })),
    },
    continuity: {
      summary: input.continuitySummary ?? null,
      pinnedNotes: [...(input.pinnedNotes ?? [])],
      continuityThroughMessageId: input.continuityThroughMessageId ?? null,
      continuityThroughCreatedAt: input.continuityThroughCreatedAt ?? null,
      continuityRevision: input.continuityRevision ?? 0,
    },
    futureMemory: {
      global: [...(input.canonicalMemory?.items ?? [])],
      thread: [],
      globalRevision: input.canonicalMemory?.globalRevision ?? 0,
    },
  };
}

export function getModelMessages(context: ThreadAgentContext): Array<{
  role: "user" | "assistant";
  content: string;
}> {
  const checkpointIndex = context.continuity.continuityThroughMessageId
    ? context.rawHistory.messages.findIndex((message) => message.id === context.continuity.continuityThroughMessageId)
    : -1;
  const sourceMessages = checkpointIndex >= 0 ? context.rawHistory.messages.slice(checkpointIndex + 1) : context.rawHistory.messages;
  return sourceMessages
    .filter(
      (message): message is {
        role: "user" | "assistant";
        content: string;
        isComplete?: boolean;
      } =>
        (message.role === "user" || message.role === "assistant") &&
        !(message.role === "assistant" && message.isComplete === false),
    )
    .map((message) => ({ role: message.role, content: message.content }));
}
