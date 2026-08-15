import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";
import type { ProfileId } from "@/lib/profiles";
import { getThreadOverview } from "@/server/db/queries";
import type { AgentContext } from "@/server/agent/context";
import { createProductionMemoryRetrievalService, type MemoryRetrieval } from "@/server/memory/retrieval";
import { normalizeMemoryLimit, normalizeMemoryQuery } from "@/server/memory/validation";

export type ThreadOverview = {
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type ThreadOverviewReader = (
  profileId: ProfileId,
  threadId: string,
) => Promise<ThreadOverview | null>;

const emptyInput = z.object({});
export const optionalToolProgressSchema = z.object({
  statusMessage: z.string().trim().min(1).max(120).optional(),
});

const searchMessagesInput = z.object({
  query: z.string().trim().min(1).max(500),
  threadId: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(10).default(5),
}).extend(optionalToolProgressSchema.shape);
const readMessagesInput = z.object({ messageId: z.string().uuid(), windowSize: z.number().int().min(1).max(10).default(3) });
const memoryReadInput = z.object({ logicalKey: z.string().trim().min(1).max(200) });
const memorySearchInput = z.object({ query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(10).default(5) }).extend(optionalToolProgressSchema.shape);

export async function readCurrentTime(context: AgentContext) {
  return {
    kind: "current_time" as const,
    serverNow: context.serverNow,
    timezone: context.timezone,
  };
}

export async function readCurrentThreadOverview(
  context: AgentContext,
  reader: ThreadOverviewReader,
) {
  const overview = await reader(context.profileId, context.threadId);
  if (!overview) {
    return {
      kind: "thread_overview" as const,
      found: false as const,
      title: null,
      createdAt: null,
      updatedAt: null,
      messageCount: 0,
    };
  }

  return {
    kind: "thread_overview" as const,
    found: true as const,
    ...overview,
  };
}

function boundedExcerpt(value: string, max = 280) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1).trimEnd()}…` : compact;
}

function openMessageAction(threadId: string, messageId: string) {
  return { type: "open_message" as const, threadId, messageId, label: "Open source" };
}

export async function searchMessages(context: AgentContext, input: z.infer<typeof searchMessagesInput>, retrieval: MemoryRetrieval) {
  const query = normalizeMemoryQuery(input.query);
  const limit = normalizeMemoryLimit(input.limit);
  const results = await retrieval.searchMessages({ profileId: context.profileId, ...input, query, limit });
  return {
    kind: "message_search" as const,
    query,
    results: results.filter((result) => result.profileId === context.profileId).map((result) => ({
      messageId: result.messageId,
      threadId: result.threadId,
      profileId: result.profileId,
      role: result.role,
      createdAt: result.createdAt,
      excerpt: boundedExcerpt(result.content),
      action: openMessageAction(result.threadId, result.messageId),
    })),
  };
}

export async function readMessages(context: AgentContext, input: z.infer<typeof readMessagesInput>, retrieval: MemoryRetrieval) {
  const result = await retrieval.readMessages(context.profileId, input.messageId, input.windowSize);
  if (!result || result.target.profileId !== context.profileId) return { kind: "message_read" as const, found: false as const, target: null, before: [], after: [], action: null };
  return {
    kind: "message_read" as const,
    found: true as const,
    thread: result.thread,
    target: result.target,
    before: result.before,
    after: result.after,
    action: openMessageAction(result.target.threadId, result.target.messageId),
  };
}

export async function listMemory(context: AgentContext, retrieval: MemoryRetrieval) {
  const documents = await retrieval.listMemory(context.profileId);
  return {
    kind: "memory_list" as const,
    results: documents.slice(0, 20).map((document) => ({
      logicalKey: document.logicalKey,
      documentRevision: document.documentRevision,
      updatedAt: document.updatedAt,
      excerpt: boundedExcerpt(document.contentMarkdown),
    })),
  };
}

export async function readMemory(context: AgentContext, input: z.infer<typeof memoryReadInput>, retrieval: MemoryRetrieval) {
  const document = await retrieval.readMemory(context.profileId, input.logicalKey);
  if (!document) return { kind: "memory_read" as const, found: false as const, document: null };
  return {
    kind: "memory_read" as const,
    found: true as const,
    document: {
      logicalKey: document.logicalKey,
      documentRevision: document.documentRevision,
      updatedAt: document.updatedAt,
      contentMarkdown: document.contentMarkdown.slice(0, 12_000),
    },
  };
}

export async function searchMemory(context: AgentContext, input: z.infer<typeof memorySearchInput>, retrieval: MemoryRetrieval) {
  const query = normalizeMemoryQuery(input.query);
  const limit = normalizeMemoryLimit(input.limit);
  const results = await retrieval.searchMemory(context.profileId, query, limit);
  return {
    kind: "memory_search" as const,
    query,
    results: results.map((result) => ({
      logicalKey: result.logicalKey,
      documentRevision: result.documentRevision,
      updatedAt: result.updatedAt,
      excerpt: boundedExcerpt(result.excerpt),
    })),
  };
}

export function createInternalTools(
  reader: ThreadOverviewReader = getThreadOverview,
  memoryRetrieval?: MemoryRetrieval,
) {
  let resolvedMemoryRetrieval = memoryRetrieval;
  const getMemoryRetrieval = () => {
    resolvedMemoryRetrieval ??= createProductionMemoryRetrievalService();
    return resolvedMemoryRetrieval;
  };
  const threadOverview = tool(
    async (_input, runtime: ToolRuntime<unknown, AgentContext>) =>
      readCurrentThreadOverview(runtime.context, reader),
    {
      name: "thread_overview",
      description: "Return only the current profile's current thread title, timestamps, and message count. This is a quick lookup; omit statusMessage.",
      schema: emptyInput,
    },
  );

  const searchMessagesTool = tool(
    async (input: z.infer<typeof searchMessagesInput>, runtime: ToolRuntime<unknown, AgentContext>) => searchMessages(runtime.context, input, getMemoryRetrieval()),
    {
      name: "search_messages",
      description: "Search this profile's prior chats when the user refers to an earlier conversation, decision, or where something was said. Return concise hits with source IDs; do not use for self-contained requests.",
      schema: searchMessagesInput,
    },
  );
  const readMessagesTool = tool(
    async (input: z.infer<typeof readMessagesInput>, runtime: ToolRuntime<unknown, AgentContext>) => readMessages(runtime.context, input, getMemoryRetrieval()),
    {
      name: "read_messages",
      description: "Read the exact historical message and a small surrounding window after search_messages identifies a source. The message ID is resolved only inside the active profile.",
      schema: readMessagesInput,
    },
  );
  const memoryListTool = tool(
    async (_input, runtime: ToolRuntime<unknown, AgentContext>) => listMemory(runtime.context, getMemoryRetrieval()),
    {
      name: "memory_list",
      description: "List the current profile's canonical memory documents for read-only inspection. Do not invent documents or claim a write.",
      schema: emptyInput,
    },
  );
  const memoryReadTool = tool(
    async (input: z.infer<typeof memoryReadInput>, runtime: ToolRuntime<unknown, AgentContext>) => readMemory(runtime.context, input, getMemoryRetrieval()),
    {
      name: "memory_read",
      description: "Read one canonical memory document by its logical key. This is read-only and profile-scoped.",
      schema: memoryReadInput,
    },
  );
  const memorySearchTool = tool(
    async (input: z.infer<typeof memorySearchInput>, runtime: ToolRuntime<unknown, AgentContext>) => searchMemory(runtime.context, input, getMemoryRetrieval()),
    {
      name: "memory_search",
      description: "Search current canonical memory documents lexically when relevant context is missing. Keep ordinary self-contained requests tool-free.",
      schema: memorySearchInput,
    },
  );

  return [threadOverview, searchMessagesTool, readMessagesTool, memoryListTool, memoryReadTool, memorySearchTool] as const;
}
