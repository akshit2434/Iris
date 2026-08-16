import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";
import type { ProfileId } from "@/lib/profiles";
import { getThreadOverview } from "@/server/db/queries";
import type { AgentContext } from "@/server/agent/context";
import { createProductionMemoryRetrievalService, type MemoryRetrieval } from "@/server/memory/retrieval";
import { isMemoryUuid, normalizeMemoryLimit, normalizeMemoryQuery } from "@/server/memory/validation";
import { createMemoryMutationService, type MemoryMutationService } from "@/server/memory/mutation";
import { createMemoryArchiveService, type MemoryArchiveService } from "@/server/memory/archive";
import { createSupabaseMemoryStore } from "@/server/memory/repository";
import { buildOpenMessageAction } from "@/lib/memory-source";

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

export type InternalToolOptions = {
  /**
   * Test/acceptance-only escape hatch for tools whose structured result is the
   * terminal response. Production leaves this empty so the agent can continue
   * with a natural assistant reply after a tool call.
   */
  returnDirectTools?: readonly string[];
  /** Profile-level saved-memory control. */
  savedMemoryEnabled?: boolean;
  /** Profile-level cross-chat history control. */
  referenceHistoryEnabled?: boolean;
};

export type InternalToolSchemaDescriptor = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

const emptyInput = z.object({});
export const optionalToolProgressSchema = z.object({
  statusMessage: z.string().trim().min(1).max(120).optional(),
});

const searchMessagesInput = z.object({
  query: z.string().trim().min(1).max(500),
  exactPhrase: z.string().trim().min(1).max(500).optional(),
  matchType: z.enum(["exact_phrase", "hybrid", "semantic"]).optional(),
  roles: z.array(z.enum(["user", "assistant", "tool"])).min(1).max(3).optional(),
  threadId: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(10).default(5),
}).extend(optionalToolProgressSchema.shape);
const readMessagesInput = z.object({ messageId: z.string().uuid(), windowSize: z.number().int().min(1).max(10).default(3) });
const memoryReadInput = z.object({ canonicalKey: z.string().trim().min(1).max(200) });
const memorySearchInput = z.object({ query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(10).default(5) }).extend(optionalToolProgressSchema.shape);
const memoryPatchInput = z.object({
  canonicalKey: z.string().trim().min(1).max(200),
  content: z.string().min(1).max(20_000),
  expectedItemRevision: z.number().int().nonnegative().nullable(),
  mutationKind: z.enum(["create", "update", "supersede", "merge"]),
  category: z.enum(["personal_fact", "preference", "instruction", "project", "goal", "relationship", "active_state", "pattern", "other"]).optional(),
  valueScope: z.enum(["single", "multi"]).optional(),
}).extend(optionalToolProgressSchema.shape);
const memoryArchiveInput = z.object({
  canonicalKey: z.string().trim().min(1).max(200),
  expectedItemRevision: z.number().int().min(1),
  reason: z.string().trim().max(240).optional(),
}).extend(optionalToolProgressSchema.shape);

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

function searchTokens(value: string) {
  return value.toLocaleLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3);
}

function historicalResultPenalty(role: "user" | "assistant" | "tool", content: string, query: string) {
  if (role === "assistant" && /\b(?:(?:you|the user)\s+(?:said|told|wrote|mentioned|shared)|here is the source|open message)\b/i.test(content)) return 1;
  if (role !== "user") return 0;
  if (/\b(?:show|find|locate|open|search|check)\b[\s\S]{0,140}\b(?:chat|conversation|thread|source|message|memory|history)\b/i.test(content)) return 1;
  const wantsQuestion = /\b(?:asked|question|questions)\b/i.test(query);
  if (!wantsQuestion && (/^\s*(?:what|where|when|which|who|why|how|can|could|would|should|do|did|does|is|are|was|were)\b/i.test(content) || /\?\s*$/.test(content))) return 1;
  return 0;
}

function rankHistoricalResults<T extends { role: "user" | "assistant" | "tool"; excerpt: string }>(results: T[], query: string): T[] {
  const queryTokens = [...new Set(searchTokens(query))];
  return results.map((result, index) => {
    const contentTokens = new Set(searchTokens(result.excerpt));
    const overlap = queryTokens.length === 0 ? 0 : queryTokens.filter((token) => contentTokens.has(token)).length / queryTokens.length;
    return { result, index, penalty: historicalResultPenalty(result.role, result.excerpt, query), overlap };
  }).sort((left, right) => left.penalty - right.penalty || right.overlap - left.overlap || left.index - right.index).map(({ result }) => result);
}

export async function searchMessages(context: AgentContext, input: z.infer<typeof searchMessagesInput>, retrieval: MemoryRetrieval) {
  const query = normalizeMemoryQuery(input.query);
  const limit = normalizeMemoryLimit(input.limit);
  // `threadId` is only an optional narrowing filter. Some providers may emit
  // natural-language sentinels such as "all" despite the JSON schema. A bad
  // optional filter must not break a safe profile-scoped history search.
  const threadId = isMemoryUuid(input.threadId) ? input.threadId : undefined;
  // Explicit historical requests already have a deterministic, profile-
  // validated preflight result. Reuse that evidence when the model makes the
  // required visible tool call instead of letting a rewritten query replace
  // the exact source with later echoes of the same fact.
  const preflightResults = context.historicalPreflightSources
    .filter((source) => source.profileId === context.profileId)
    .filter((source) => !threadId || source.threadId === threadId)
    .filter((source) => !input.roles || input.roles.includes(source.role))
    .slice(0, limit)
    .map((source) => ({
      ...source,
      action: buildOpenMessageAction(source.threadId, source.messageId, "Open message"),
    }))
    .filter((source): source is typeof source & { action: NonNullable<typeof source.action> } => source.action !== null);
  // A single deterministic hit is safe to reuse when the model paraphrases
  // the request. Multiple hits can represent ambiguity or a compound request;
  // in that case each visible search must honor its own query instead of
  // replaying the same preflight candidates for every tool call.
  if (preflightResults.length === 1) {
    return { kind: "message_search" as const, query, results: preflightResults };
  }
  const results = await retrieval.searchMessages({
    profileId: context.profileId,
    ...input,
    threadId,
    excludeThreadId: threadId ? undefined : context.threadId,
    query,
    limit,
  });
  const validatedResults = await Promise.all(results.map(async (result) => {
    if (result.profileId !== context.profileId) return null;
    const window = await retrieval.readMessages(context.profileId, result.messageId, 1).catch(() => null);
    if (!window
      || window.target.profileId !== context.profileId
      || window.target.messageId !== result.messageId
      || window.target.threadId !== result.threadId
      || window.target.role !== result.role
      || window.thread.profileId !== context.profileId) return null;
    const action = buildOpenMessageAction(result.threadId, result.messageId, "Open message");
    return action ? {
      messageId: result.messageId,
      threadId: result.threadId,
      profileId: result.profileId,
      role: result.role,
      createdAt: result.createdAt,
      threadTitle: window.thread.title,
      excerpt: boundedExcerpt(result.content),
      matchType: result.matchType ?? input.matchType ?? "hybrid",
      scores: { lexical: result.lexicalScore, semantic: result.semanticScore, combined: result.combinedScore },
      action,
    } : null;
  }));
  return {
    kind: "message_search" as const,
    query,
    results: rankHistoricalResults(validatedResults.filter((result): result is NonNullable<typeof result> => result !== null), query),
  };
}

export async function readMessages(context: AgentContext, input: z.infer<typeof readMessagesInput>, retrieval: MemoryRetrieval) {
  const result = await retrieval.readMessages(context.profileId, input.messageId, input.windowSize);
  if (!result
    || result.target.profileId !== context.profileId
    || result.thread.profileId !== context.profileId
    || result.target.messageId !== input.messageId
    || result.target.threadId !== result.thread.id) {
    return { kind: "message_read" as const, found: false as const, target: null, before: [], after: [], action: null };
  }
  return {
    kind: "message_read" as const,
    found: true as const,
    thread: result.thread,
    target: result.target,
    before: result.before,
    after: result.after,
    action: buildOpenMessageAction(result.target.threadId, result.target.messageId, "Open message"),
  };
}

export async function listMemory(context: AgentContext, retrieval: MemoryRetrieval) {
  const items = await retrieval.listMemory(context.profileId);
  return {
    kind: "memory_list" as const,
    results: items.slice(0, 20).map((item) => ({
      canonicalKey: item.canonicalKey,
      itemRevision: item.itemRevision,
      updatedAt: item.updatedAt,
      category: item.category,
      excerpt: boundedExcerpt(item.content),
    })),
  };
}

export async function readMemory(context: AgentContext, input: z.infer<typeof memoryReadInput>, retrieval: MemoryRetrieval) {
  const item = await retrieval.readMemory(context.profileId, input.canonicalKey);
  if (!item) return { kind: "memory_read" as const, found: false as const, item: null };
  const sources = context.memoryControls.referenceHistoryEnabled && retrieval.memorySources
    ? await retrieval.memorySources(context.profileId, item.canonicalKey, 3).catch(() => [])
    : [];
  return {
    kind: "memory_read" as const,
    found: true as const,
    item: {
      canonicalKey: item.canonicalKey,
      itemRevision: item.itemRevision,
      updatedAt: item.updatedAt,
      category: item.category,
      content: item.content.slice(0, 12_000),
      sourceStatus: !context.memoryControls.referenceHistoryEnabled ? "disabled" as const : sources.length > 0 ? "available" as const : "unavailable" as const,
      sources: sources.map((source) => ({
        messageId: source.messageId,
        threadId: source.threadId,
        profileId: source.profileId,
        role: source.role,
        createdAt: source.createdAt,
        threadTitle: source.threadTitle,
        relation: source.relation,
        excerpt: boundedExcerpt(source.content),
        action: buildOpenMessageAction(source.threadId, source.messageId, "Open message"),
      })),
    },
  };
}

export async function searchMemory(context: AgentContext, input: z.infer<typeof memorySearchInput>, retrieval: MemoryRetrieval) {
  const query = normalizeMemoryQuery(input.query);
  const limit = normalizeMemoryLimit(input.limit);
  const results = await retrieval.searchMemory(context.profileId, query, limit);
  const enriched = await Promise.all(results.map(async (result) => {
    const sources = context.memoryControls.referenceHistoryEnabled && retrieval.memorySources
      ? await retrieval.memorySources(context.profileId, result.canonicalKey, 3).catch(() => [])
      : [];
    return {
      canonicalKey: result.canonicalKey,
      itemRevision: result.itemRevision,
      updatedAt: result.updatedAt,
      excerpt: boundedExcerpt(result.excerpt),
      sourceStatus: !context.memoryControls.referenceHistoryEnabled ? "disabled" as const : sources.length > 0 ? "available" as const : "unavailable" as const,
      sources: sources.map((source) => ({
        messageId: source.messageId,
        threadId: source.threadId,
        profileId: source.profileId,
        role: source.role,
        createdAt: source.createdAt,
        threadTitle: source.threadTitle,
        relation: source.relation,
        excerpt: boundedExcerpt(source.content),
        action: buildOpenMessageAction(source.threadId, source.messageId, "Open message"),
      })),
    };
  }));
  return {
    kind: "memory_search" as const,
    query,
    results: enriched,
  };
}

export async function patchMemory(context: AgentContext, input: z.infer<typeof memoryPatchInput>, mutation: MemoryMutationService, toolCallId: string) {
  if (!context.currentUserMessageId || !context.agentRunId) {
    return { kind: "memory_patch" as const, status: "conflict" as const, canonicalKey: input.canonicalKey.trim(), reason: "Memory writes are available only during a persisted user turn.", candidates: [] };
  }
  const result = await mutation.apply({
    profileId: context.profileId,
    threadId: context.threadId,
    currentUserMessageId: context.currentUserMessageId,
    agentRunId: context.agentRunId,
    toolCallId,
    canonicalKey: input.canonicalKey,
    content: input.content,
    expectedItemRevision: input.expectedItemRevision,
    mutationKind: input.mutationKind,
    category: input.category,
    valueScope: input.valueScope,
  });
  if (result.status !== "applied") return { kind: "memory_patch" as const, ...result };
  return {
    kind: "memory_patch" as const,
    status: "applied" as const,
    canonicalKey: result.canonicalKey,
    itemRevision: result.revision.itemRevision,
    profileGlobalRevision: result.revision.profileGlobalRevision,
    revisionId: result.revision.revisionId,
  };
}

export async function archiveMemory(context: AgentContext, input: z.infer<typeof memoryArchiveInput>, archive: MemoryArchiveService, toolCallId: string) {
  if (!context.currentUserMessageId || !context.agentRunId) {
    return { kind: "memory_archive" as const, status: "conflict" as const, canonicalKey: input.canonicalKey.trim(), reason: "Memory archives are available only during a persisted user turn." };
  }
  const result = await archive.archive({
    profileId: context.profileId,
    threadId: context.threadId,
    currentUserMessageId: context.currentUserMessageId,
    agentRunId: context.agentRunId,
    toolCallId,
    canonicalKey: input.canonicalKey,
    expectedItemRevision: input.expectedItemRevision,
    reason: input.reason,
  });
  if (result.status !== "applied") return { kind: "memory_archive" as const, ...result };
  return {
    kind: "memory_archive" as const,
    status: "applied" as const,
    canonicalKey: result.canonicalKey,
    itemRevision: result.revision.itemRevision,
    profileGlobalRevision: result.revision.profileGlobalRevision,
    revisionId: result.revision.revisionId,
  };
}

export function createInternalTools(
  reader: ThreadOverviewReader = getThreadOverview,
  memoryRetrieval?: MemoryRetrieval,
  memoryMutation?: MemoryMutationService,
  memoryArchive?: MemoryArchiveService,
  options: InternalToolOptions = {},
) {
  const isReturnDirect = (toolName: string) => options.returnDirectTools?.includes(toolName) ?? false;
  let resolvedMemoryRetrieval = memoryRetrieval;
  const getMemoryRetrieval = () => {
    resolvedMemoryRetrieval ??= createProductionMemoryRetrievalService();
    return resolvedMemoryRetrieval;
  };
  let resolvedMemoryMutation = memoryMutation;
  const getMemoryMutation = () => {
    resolvedMemoryMutation ??= createMemoryMutationService(createSupabaseMemoryStore());
    return resolvedMemoryMutation;
  };
  let resolvedMemoryArchive = memoryArchive;
  const getMemoryArchive = () => {
    resolvedMemoryArchive ??= createMemoryArchiveService(createSupabaseMemoryStore());
    return resolvedMemoryArchive;
  };
  const threadOverview = tool(
    async (_input, runtime: ToolRuntime<unknown, AgentContext>) =>
      readCurrentThreadOverview(runtime.context, reader),
    {
      name: "thread_overview",
      description: "Return only the current profile's current thread title, timestamps, and message count. This is a quick lookup; omit statusMessage.",
      schema: emptyInput,
      returnDirect: isReturnDirect("thread_overview"),
    },
  );

  const searchMessagesTool = tool(
    async (input: z.infer<typeof searchMessagesInput>, runtime: ToolRuntime<unknown, AgentContext>) => searchMessages(runtime.context, input, getMemoryRetrieval()),
    {
      name: "search_messages",
      description: "Search this profile's retained chats when the user refers to an earlier conversation, decision, or exact source. For a where-I-told-you or neutral exact-source request about a fact already present in prefilled canonical memory, call memory_search first and use its provenance; use this only if that provenance is unavailable. For where-you-told-me requests, start here with roles=['assistant']. A concrete non-empty query is required; never call this with an empty object. Omit threadId to search all chats; provide it only to restrict the search to one known UUID. Set roles=['user'] for where-I-told-you requests and omit roles for neutral requests. Use exact_phrase only for wording the user actually quoted, hybrid for normal evidence queries, and semantic only when meaning matters. Return concise profile-validated hits with source actions; do not use for self-contained requests.",
      schema: searchMessagesInput,
      returnDirect: isReturnDirect("search_messages"),
    },
  );
  const readMessagesTool = tool(
    async (input: z.infer<typeof readMessagesInput>, runtime: ToolRuntime<unknown, AgentContext>) => readMessages(runtime.context, input, getMemoryRetrieval()),
    {
      name: "read_messages",
      description: "Read the exact historical message and a small surrounding window after search_messages identifies a source. The message ID is resolved only inside the active profile.",
      schema: readMessagesInput,
      returnDirect: isReturnDirect("read_messages"),
    },
  );
  const memoryListTool = tool(
    async (_input, runtime: ToolRuntime<unknown, AgentContext>) => listMemory(runtime.context, getMemoryRetrieval()),
    {
      name: "memory_list",
      description: "List the current profile's structured saved memory items for read-only inspection. Do not invent items or claim a write.",
      schema: emptyInput,
      returnDirect: isReturnDirect("memory_list"),
    },
  );
  const memoryReadTool = tool(
    async (input: z.infer<typeof memoryReadInput>, runtime: ToolRuntime<unknown, AgentContext>) => readMemory(runtime.context, input, getMemoryRetrieval()),
    {
      name: "memory_read",
      description: "Read one structured saved memory item by canonical key. This is read-only and profile-scoped.",
      schema: memoryReadInput,
      returnDirect: isReturnDirect("memory_read"),
    },
  );
  const memorySearchTool = tool(
    async (input: z.infer<typeof memorySearchInput>, runtime: ToolRuntime<unknown, AgentContext>) => searchMemory(runtime.context, input, getMemoryRetrieval()),
    {
      name: "memory_search",
      description: "Search current structured saved memory items when relevant personal context or canonical user provenance is needed. This is the mandatory first tool for a where-I-told-you or neutral exact-source request whose fact appears in prefilled canonical memory. Do not use it as the source for where-you-told-me requests; search assistant messages instead. Search the stable fact or subject, use a validated original-message source when available, and stop before searching raw chats. Keep ordinary self-contained requests tool-free.",
      schema: memorySearchInput,
      returnDirect: isReturnDirect("memory_search"),
    },
  );
  const memoryPatchTool = tool(
    async (input: z.infer<typeof memoryPatchInput>, runtime: ToolRuntime<unknown, AgentContext>) => patchMemory(runtime.context, input, getMemoryMutation(), runtime.toolCallId),
    {
      name: "memory_patch",
      description: "Use only when the user explicitly asks to remember, correct, or preserve a durable fact, or a stable fact clearly has future value. Search/read related memory first when uncertain. Submit plain natural-language content with the current expected item revision; do not store transient chatter, secrets, or speculative psychology. This is profile/thread scoped and read-only tools cannot be bypassed.",
      schema: memoryPatchInput,
      returnDirect: isReturnDirect("memory_patch"),
    },
  );
  const memoryArchiveTool = tool(
    async (input: z.infer<typeof memoryArchiveInput>, runtime: ToolRuntime<unknown, AgentContext>) => archiveMemory(runtime.context, input, getMemoryArchive(), runtime.toolCallId),
    {
      name: "memory_archive",
      description: "Use only when the user clearly asks Iris to forget, stop treating, or archive a saved memory item. Keep the raw transcript; this is not legal or physical erasure. Supply the current expected item revision after reading the item.",
      schema: memoryArchiveInput,
      returnDirect: isReturnDirect("memory_archive"),
    },
  );

  const historicalTools = options.referenceHistoryEnabled === false ? [] : [searchMessagesTool, readMessagesTool];
  const memoryTools = options.savedMemoryEnabled === false
    ? []
    : [memoryListTool, memoryReadTool, memorySearchTool, memoryPatchTool, memoryArchiveTool];
  return [threadOverview, ...historicalTools, ...memoryTools] as const;
}

/**
 * Return the serialized tool definitions used for token accounting. This is
 * intentionally separate from model invocation; it performs no I/O and keeps
 * raw tool schemas out of telemetry while still counting their JSON overhead.
 */
export function getInternalToolSchemaDescriptors(options: InternalToolOptions = {}): InternalToolSchemaDescriptor[] {
  return createInternalTools(undefined, undefined, undefined, undefined, options).map((internalTool) => {
    let parameters: Record<string, unknown> = { type: "object" };
    try {
      parameters = z.toJSONSchema(internalTool.schema) as Record<string, unknown>;
    } catch {
      // A schema conversion failure should not make the chat unavailable. The
      // fallback still accounts for the tool name and description.
    }
    return {
      name: internalTool.name,
      description: internalTool.description ?? "",
      parameters,
    };
  });
}
