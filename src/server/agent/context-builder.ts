import type { Message } from "@/lib/types";
import type { CanonicalMemoryContext } from "@/server/memory/context-budget";

export type AgentContextMessage = Pick<Message, "role" | "content" | "isComplete">;
export type AgentMessage = AgentContextMessage;

export type ThreadAgentContext = {
  rawHistory: {
    messages: AgentContextMessage[];
  };
  continuity: {
    summary: string | null;
    pinnedNotes: string[];
  };
  futureMemory: {
    global: CanonicalMemoryContext["documents"];
    thread: readonly [];
    globalRevision: number;
  };
};

export function buildThreadAgentContext(input: {
  messages: AgentContextMessage[];
  continuitySummary?: string | null;
  pinnedNotes?: string[];
  canonicalMemory?: CanonicalMemoryContext;
}): ThreadAgentContext {
  // Keep the complete raw tail until a usable continuity summary exists. This
  // boundary deliberately does not summarize, retrieve, or compact history.
  return {
    rawHistory: {
      messages: input.messages.map((message) => ({
        role: message.role,
        content: message.content,
        isComplete: message.isComplete,
      })),
    },
    continuity: {
      summary: input.continuitySummary ?? null,
      pinnedNotes: [...(input.pinnedNotes ?? [])],
    },
    futureMemory: {
      global: [...(input.canonicalMemory?.documents ?? [])],
      thread: [],
      globalRevision: input.canonicalMemory?.globalRevision ?? 0,
    },
  };
}

export function getModelMessages(context: ThreadAgentContext): Array<{
  role: "user" | "assistant";
  content: string;
}> {
  return context.rawHistory.messages
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
