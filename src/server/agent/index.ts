import "server-only";

import { ChatOpenRouter } from "@langchain/openrouter";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  createAgent,
  createMiddleware,
  dynamicSystemPromptMiddleware,
} from "langchain";
import type { ProfileId } from "@/lib/profiles";
import type { AgentMessage } from "@/server/agent/context-builder";
import {
  agentContextSchema,
  buildDynamicSystemPrompt,
  type AgentContext,
} from "@/server/agent/context";
import { createInternalTools, type InternalToolOptions, type ThreadOverviewReader } from "@/server/agent/tools";
import type { MemoryRetrieval } from "@/server/memory/retrieval";
import type { MemoryMutationService } from "@/server/memory/mutation";
import type { MemoryArchiveService } from "@/server/memory/archive";
import { sanitizeForEvent, sanitizeStatusMessage, type SafeJson } from "@/server/agent/protocol";
import {
  extractTraceUsage,
  type AgentTraceRecorder,
  type TraceExecutionKind,
} from "@/server/agent/observability";

export const DEFAULT_MODEL = "openai/gpt-5.6-luna";

export type AgentRuntimeEvent =
  | { type: "text_delta"; text: string }
  | {
      type: "usage_observed";
      usage: {
        inputTokens: number | null;
        outputTokens: number | null;
        totalTokens: number | null;
        cachedInputTokens?: number | null;
        reasoningOutputTokens?: number | null;
      };
    }
  | { type: "tool_started"; toolCallId: string; toolName: string; input: SafeJson; statusMessage?: string }
  | {
      type: "tool_finished";
      toolCallId: string;
      toolName: string;
      output: SafeJson;
      ok: boolean;
      statusMessage?: string;
    };

export type AgentModel = BaseChatModel;

type RuntimeAgent = ReturnType<typeof createAgent>;

export function getConfiguredModelName() {
  return process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL;
}

/**
 * The only factory allowed to construct a production OpenRouter client.
 * Tests and local deterministic callers must inject a LangChain chat model.
 */
export function createProductionChatModel(): AgentModel {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is required.");
  }

  return new ChatOpenRouter({
    apiKey,
    model: getConfiguredModelName(),
    temperature: 0.2,
    maxRetries: 0,
  });
}

export function createIrisAgent(input: {
  model: AgentModel;
  threadOverviewReader?: ThreadOverviewReader;
  memoryRetrieval?: MemoryRetrieval;
  memoryMutation?: MemoryMutationService;
  memoryArchive?: MemoryArchiveService;
  returnDirectTools?: InternalToolOptions["returnDirectTools"];
  savedMemoryEnabled?: InternalToolOptions["savedMemoryEnabled"];
  referenceHistoryEnabled?: InternalToolOptions["referenceHistoryEnabled"];
  accountabilityEnabled?: InternalToolOptions["accountabilityEnabled"];
  webSearchEnabled?: InternalToolOptions["webSearchEnabled"];
  filesEnabled?: InternalToolOptions["filesEnabled"];
  forceToolName?: string;
  observability?: AgentTraceRecorder;
  executionKind?: TraceExecutionKind;
}): RuntimeAgent {
  const dynamicPrompt = dynamicSystemPromptMiddleware<AgentContext>((_state, runtime) =>
    buildDynamicSystemPrompt(runtime.context),
  );
  let firstToolChoiceApplied = false;
  const acceptanceToolChoice = input.forceToolName
    ? createMiddleware({
        name: "acceptance-tool-choice",
        wrapModelCall: async (request, handler) => {
          if (firstToolChoiceApplied) return handler(request);
          firstToolChoiceApplied = true;
          return handler({
            ...request,
            toolChoice: { type: "function", function: { name: input.forceToolName! } },
          });
        },
      })
    : null;
  const observabilityMiddleware = input.observability
    ? createMiddleware({
        name: "iris-observability",
        wrapModelCall: async (request, handler) => {
          const modelRecord = request.model as unknown as Record<string, unknown>;
          const configuredModel = typeof modelRecord.model === "string" ? modelRecord.model : undefined;
          const handle = await input.observability!.startModelCall({ model: configuredModel, executionKind: input.executionKind });
          try {
            const response = await handler(request);
            await input.observability!.completeModelCall({ handle, response });
            return response;
          } catch (error) {
            await input.observability!.failModelCall({ handle, error });
            throw error;
          }
        },
      })
    : null;
  const middleware = [
    dynamicPrompt,
    ...(acceptanceToolChoice ? [acceptanceToolChoice] : []),
    ...(observabilityMiddleware ? [observabilityMiddleware] : []),
  ];

  return createAgent({
    model: input.model,
    contextSchema: agentContextSchema,
    middleware,
    tools: [...createInternalTools(input.threadOverviewReader, input.memoryRetrieval, input.memoryMutation, input.memoryArchive, { returnDirectTools: input.returnDirectTools, savedMemoryEnabled: input.savedMemoryEnabled, referenceHistoryEnabled: input.referenceHistoryEnabled, accountabilityEnabled: input.accountabilityEnabled, webSearchEnabled: input.webSearchEnabled, filesEnabled: input.filesEnabled })] as unknown as NonNullable<Parameters<typeof createAgent>[0]["tools"]>,
  });
}

export function createProductionAgent(input?: {
  threadOverviewReader?: ThreadOverviewReader;
  memoryRetrieval?: MemoryRetrieval;
  memoryMutation?: MemoryMutationService;
  memoryArchive?: MemoryArchiveService;
  returnDirectTools?: InternalToolOptions["returnDirectTools"];
  savedMemoryEnabled?: InternalToolOptions["savedMemoryEnabled"];
  referenceHistoryEnabled?: InternalToolOptions["referenceHistoryEnabled"];
  accountabilityEnabled?: InternalToolOptions["accountabilityEnabled"];
  webSearchEnabled?: InternalToolOptions["webSearchEnabled"];
  filesEnabled?: InternalToolOptions["filesEnabled"];
  forceToolName?: string;
  observability?: AgentTraceRecorder;
  executionKind?: TraceExecutionKind;
}): RuntimeAgent {
  return createIrisAgent({
    model: createProductionChatModel(),
    threadOverviewReader: input?.threadOverviewReader,
    memoryRetrieval: input?.memoryRetrieval,
    memoryMutation: input?.memoryMutation,
    memoryArchive: input?.memoryArchive,
    returnDirectTools: input?.returnDirectTools,
    savedMemoryEnabled: input?.savedMemoryEnabled,
    referenceHistoryEnabled: input?.referenceHistoryEnabled,
    accountabilityEnabled: input?.accountabilityEnabled,
    webSearchEnabled: input?.webSearchEnabled,
    filesEnabled: input?.filesEnabled,
    forceToolName: input?.forceToolName,
    observability: input?.observability,
    executionKind: input?.executionKind,
  });
}

function getTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (typeof block === "object" && block !== null && "text" in block) {
        const text = (block as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .join("");
}

function parseToolInput(value: unknown): SafeJson {
  if (typeof value !== "string") return sanitizeForEvent(value);
  try {
    return sanitizeForEvent(JSON.parse(value));
  } catch {
    return value.slice(0, 4000);
  }
}

/** Preserve structured tool results while keeping legacy plain-string results intact. */
export function parseToolOutput(value: unknown): SafeJson {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return sanitizeForEvent(value);
  const raw = typeof value === "string" ? value : getTextContent(value);
  try {
    return sanitizeForEvent(JSON.parse(raw));
  } catch {
    return raw.slice(0, 4000);
  }
}

function getToolCalls(message: Record<string, unknown>) {
  const completeCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const partialCalls = Array.isArray(message.tool_call_chunks) ? message.tool_call_chunks : [];
  // AIMessageChunk exposes an empty `tool_calls` array alongside non-empty
  // `tool_call_chunks`; prefer complete calls when available and otherwise
  // inspect the incremental chunks.
  const calls = completeCalls.length > 0 ? completeCalls : partialCalls;
  const seen = new Set<string>();

  return calls.flatMap((call) => {
    if (typeof call !== "object" || call === null) return [];
    const value = call as Record<string, unknown>;
    const name = typeof value.name === "string" && value.name.length > 0 ? value.name : null;
    if (!name) return [];
    const id = typeof value.id === "string" && value.id.length > 0
      ? value.id
      : typeof value.index === "number"
        ? `${name}:${value.index}`
        : `${name}:${JSON.stringify(value.args ?? {})}`;
    if (seen.has(id)) return [];
    seen.add(id);
    const parsedInput = parseToolInput(value.args ?? value.input ?? {});
    const statusMessage = sanitizeStatusMessage(
      typeof parsedInput === "object" && parsedInput !== null && !Array.isArray(parsedInput)
        ? parsedInput.statusMessage
        : undefined,
    );
    return [{
      id,
      name,
      input: parsedInput,
      ...(statusMessage ? { statusMessage } : {}),
    }];
  });
}

function getToolResult(message: Record<string, unknown>) {
  if (message.type !== "tool") return null;
  const toolCallId = typeof message.tool_call_id === "string" ? message.tool_call_id : "unknown";
  const toolName = typeof message.name === "string" ? message.name : "unknown_tool";
  const output = parseToolOutput(message.content);
  let statusMessage: string | undefined;
  if (typeof output === "object" && output !== null && !Array.isArray(output)) {
    statusMessage = sanitizeStatusMessage((output as Record<string, unknown>).statusMessage);
  }
  return {
    toolCallId,
    toolName,
    output,
    ok: message.status !== "error",
    ...(statusMessage ? { statusMessage } : {}),
  };
}

/** Extract provider usage without persisting response prompts or raw metadata. */
export function extractAgentUsage(message: Record<string, unknown>) {
  return extractTraceUsage(message);
}

/** Project the message shapes emitted by LangChain's `messages` stream. */
export function extractAgentMessageEvents(message: Record<string, unknown>): AgentRuntimeEvent[] {
  const events: AgentRuntimeEvent[] = getToolCalls(message).map((call) => ({
    type: "tool_started",
    toolCallId: call.id,
    toolName: call.name,
    input: call.input,
    ...(call.statusMessage ? { statusMessage: call.statusMessage } : {}),
  }));
  const result = getToolResult(message);
  if (result) events.push({ type: "tool_finished", ...result });
  // ToolMessage content is the tool result, not assistant text.
  if (message.type === "ai") {
    const text = getTextContent(message.content);
    if (text) events.push({ type: "text_delta", text });
  }
  return events;
}

export async function* streamAgentEvents(input: {
  context: AgentContext;
  messages: AgentMessage[];
  model?: AgentModel;
  signal?: AbortSignal;
  threadOverviewReader?: ThreadOverviewReader;
  memoryRetrieval?: MemoryRetrieval;
  memoryMutation?: MemoryMutationService;
  memoryArchive?: MemoryArchiveService;
  returnDirectTools?: InternalToolOptions["returnDirectTools"];
  savedMemoryEnabled?: InternalToolOptions["savedMemoryEnabled"];
  referenceHistoryEnabled?: InternalToolOptions["referenceHistoryEnabled"];
  accountabilityEnabled?: InternalToolOptions["accountabilityEnabled"];
  webSearchEnabled?: InternalToolOptions["webSearchEnabled"];
  filesEnabled?: InternalToolOptions["filesEnabled"];
  forceToolName?: string;
  observability?: AgentTraceRecorder;
  executionKind?: TraceExecutionKind;
}): AsyncGenerator<AgentRuntimeEvent> {
  const agent = input.model
    ? createIrisAgent({ model: input.model, threadOverviewReader: input.threadOverviewReader, memoryRetrieval: input.memoryRetrieval, memoryMutation: input.memoryMutation, memoryArchive: input.memoryArchive, returnDirectTools: input.returnDirectTools, savedMemoryEnabled: input.savedMemoryEnabled, referenceHistoryEnabled: input.referenceHistoryEnabled, accountabilityEnabled: input.accountabilityEnabled, webSearchEnabled: input.webSearchEnabled, filesEnabled: input.filesEnabled, forceToolName: input.forceToolName, observability: input.observability, executionKind: input.executionKind })
    : createProductionAgent({ threadOverviewReader: input.threadOverviewReader, memoryRetrieval: input.memoryRetrieval, memoryMutation: input.memoryMutation, memoryArchive: input.memoryArchive, returnDirectTools: input.returnDirectTools, savedMemoryEnabled: input.savedMemoryEnabled, referenceHistoryEnabled: input.referenceHistoryEnabled, accountabilityEnabled: input.accountabilityEnabled, webSearchEnabled: input.webSearchEnabled, filesEnabled: input.filesEnabled, forceToolName: input.forceToolName, observability: input.observability, executionKind: input.executionKind });
  const stream = await agent.stream(
    { messages: input.messages },
    { context: input.context, signal: input.signal, streamMode: "messages" },
  );
  const startedTools = new Set<string>();
  const usageByResponse = new Map<string, NonNullable<ReturnType<typeof extractAgentUsage>>>();
  let usageWithoutId: NonNullable<ReturnType<typeof extractAgentUsage>> | null = null;

  for await (const chunk of stream) {
    const message = (Array.isArray(chunk) ? chunk[0] : chunk) as {
      content?: unknown;
      type?: string;
      tool_calls?: unknown;
      tool_call_chunks?: unknown;
      tool_call_id?: unknown;
      name?: unknown;
      status?: unknown;
    };
    const messageRecord = message as Record<string, unknown>;

    const usage = extractAgentUsage(messageRecord);
    if (usage) {
      const responseMetadata = typeof messageRecord.response_metadata === "object" && messageRecord.response_metadata !== null
        ? messageRecord.response_metadata as Record<string, unknown>
        : {};
      const key = typeof messageRecord.id === "string"
        ? messageRecord.id
        : typeof responseMetadata.id === "string"
          ? responseMetadata.id
          : null;
      if (key) usageByResponse.set(key, usage);
      else usageWithoutId = usage;
    }

    for (const event of extractAgentMessageEvents(messageRecord)) {
      if (event.type === "tool_started") {
        if (startedTools.has(event.toolCallId)) continue;
        startedTools.add(event.toolCallId);
      }
      yield event;
    }
  }

  const usages = [...usageByResponse.values(), ...(usageWithoutId ? [usageWithoutId] : [])];
  if (usages.length > 0) {
    const addNullable = (left: number | null, right: number | null) =>
      left === null || right === null ? left ?? right : left + right;
    const addOptional = (left: number | undefined, right: number | undefined) =>
      left === undefined || right === undefined ? left ?? right : left + right;
    const optionalNumber = (value: number | null | undefined) => typeof value === "number" ? value : undefined;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let totalTokens: number | null = null;
    let cachedInputTokens: number | undefined;
    let reasoningOutputTokens: number | undefined;
    for (const usage of usages) {
      inputTokens = addNullable(inputTokens, usage.inputTokens);
      outputTokens = addNullable(outputTokens, usage.outputTokens);
      totalTokens = addNullable(totalTokens, usage.totalTokens);
      cachedInputTokens = addOptional(cachedInputTokens, optionalNumber(usage.cachedInputTokens));
      reasoningOutputTokens = addOptional(reasoningOutputTokens, optionalNumber(usage.reasoningOutputTokens));
    }
    const aggregate = { inputTokens, outputTokens, totalTokens, cachedInputTokens, reasoningOutputTokens };
    yield { type: "usage_observed", usage: aggregate };
  }
}

export async function* streamAssistantReply(input: {
  profileId: ProfileId;
  context: AgentContext;
  messages: AgentMessage[];
  model?: AgentModel;
  signal?: AbortSignal;
  threadOverviewReader?: ThreadOverviewReader;
  memoryRetrieval?: MemoryRetrieval;
  memoryMutation?: MemoryMutationService;
  memoryArchive?: MemoryArchiveService;
  returnDirectTools?: InternalToolOptions["returnDirectTools"];
  savedMemoryEnabled?: InternalToolOptions["savedMemoryEnabled"];
  referenceHistoryEnabled?: InternalToolOptions["referenceHistoryEnabled"];
  accountabilityEnabled?: InternalToolOptions["accountabilityEnabled"];
  webSearchEnabled?: InternalToolOptions["webSearchEnabled"];
  filesEnabled?: InternalToolOptions["filesEnabled"];
  forceToolName?: string;
}) {
  void input.profileId;
  for await (const event of streamAgentEvents(input)) {
    if (event.type === "text_delta") yield event.text;
  }
}
