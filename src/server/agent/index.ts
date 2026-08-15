import "server-only";

import { ChatOpenRouter } from "@langchain/openrouter";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  createAgent,
  dynamicSystemPromptMiddleware,
} from "langchain";
import type { ProfileId } from "@/lib/profiles";
import type { AgentMessage } from "@/server/agent/context-builder";
import {
  agentContextSchema,
  buildDynamicSystemPrompt,
  type AgentContext,
} from "@/server/agent/context";
import { createInternalTools, type ThreadOverviewReader } from "@/server/agent/tools";
import { sanitizeForEvent, type SafeJson } from "@/server/agent/protocol";

export const DEFAULT_MODEL = "openai/gpt-5.6-luna";

export type AgentRuntimeEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_started"; toolCallId: string; toolName: string; input: SafeJson }
  | {
      type: "tool_finished";
      toolCallId: string;
      toolName: string;
      output: SafeJson;
      ok: boolean;
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
  });
}

export function createIrisAgent(input: {
  model: AgentModel;
  threadOverviewReader?: ThreadOverviewReader;
}): RuntimeAgent {
  const dynamicPrompt = dynamicSystemPromptMiddleware<AgentContext>((_state, runtime) =>
    buildDynamicSystemPrompt(runtime.context),
  );

  return createAgent({
    model: input.model,
    contextSchema: agentContextSchema,
    middleware: [dynamicPrompt],
    tools: [...createInternalTools(input.threadOverviewReader)],
  });
}

export function createProductionAgent(input?: {
  threadOverviewReader?: ThreadOverviewReader;
}): RuntimeAgent {
  return createIrisAgent({
    model: createProductionChatModel(),
    threadOverviewReader: input?.threadOverviewReader,
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
    return [{
      id,
      name,
      input: parseToolInput(value.args ?? value.input ?? {}),
    }];
  });
}

function getToolResult(message: Record<string, unknown>) {
  if (message.type !== "tool") return null;
  const toolCallId = typeof message.tool_call_id === "string" ? message.tool_call_id : "unknown";
  const toolName = typeof message.name === "string" ? message.name : "unknown_tool";
  return {
    toolCallId,
    toolName,
    output: sanitizeForEvent(message.content),
    ok: message.status !== "error",
  };
}

/** Project the message shapes emitted by LangChain's `messages` stream. */
export function extractAgentMessageEvents(message: Record<string, unknown>): AgentRuntimeEvent[] {
  const events: AgentRuntimeEvent[] = getToolCalls(message).map((call) => ({
    type: "tool_started",
    toolCallId: call.id,
    toolName: call.name,
    input: call.input,
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
  threadOverviewReader?: ThreadOverviewReader;
}): AsyncGenerator<AgentRuntimeEvent> {
  const agent = input.model
    ? createIrisAgent({ model: input.model, threadOverviewReader: input.threadOverviewReader })
    : createProductionAgent({ threadOverviewReader: input.threadOverviewReader });
  const stream = await agent.stream(
    { messages: input.messages },
    { context: input.context, streamMode: "messages" },
  );
  const startedTools = new Set<string>();

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

    for (const event of extractAgentMessageEvents(messageRecord)) {
      if (event.type === "tool_started") {
        if (startedTools.has(event.toolCallId)) continue;
        startedTools.add(event.toolCallId);
      }
      yield event;
    }
  }
}

export async function* streamAssistantReply(input: {
  profileId: ProfileId;
  context: AgentContext;
  messages: AgentMessage[];
  model?: AgentModel;
  threadOverviewReader?: ThreadOverviewReader;
}) {
  void input.profileId;
  for await (const event of streamAgentEvents(input)) {
    if (event.type === "text_delta") yield event.text;
  }
}
