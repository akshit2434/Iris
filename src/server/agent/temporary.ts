import "server-only";

import type { ProfileId } from "@/lib/profiles";
import { createDisabledMemoryArchive, createDisabledMemoryMutation, createDisabledMemoryRetrieval, createTemporaryThreadOverviewReader } from "@/server/memory/disabled";
import { assembleTokenBudgetedContext, ContextBudgetError } from "@/server/agent/context-assembler";
import { createTokenEstimator } from "@/server/agent/token-budget";
import { createAgentContext, buildDynamicSystemPrompt } from "@/server/agent/context";
import { getInternalToolSchemaDescriptors } from "@/server/agent/tools";
import { getConfiguredModelName, streamAgentEvents } from "@/server/agent";
import { AGENT_STREAM_PROTOCOL, safeFailure, sanitizeForEvent, type AgentStreamEvent } from "@/server/agent/protocol";
import type { AgentMessage } from "@/server/agent/context-builder";

const MAX_HISTORY_MESSAGES = 160;
const MAX_HISTORY_CHARS = 500_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TemporaryHistoryInput = Array<{
  id?: unknown;
  role?: unknown;
  content?: unknown;
}>;

export type TemporaryAgentInput = {
  profileId: ProfileId;
  profileLabel: string;
  temporaryId: string;
  requestId: string;
  content: string;
  timezone: unknown;
  history?: TemporaryHistoryInput;
  model?: string;
};

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function boundedHistory(input: TemporaryHistoryInput | undefined): AgentMessage[] {
  if (!Array.isArray(input)) return [];
  const selected: AgentMessage[] = [];
  let chars = 0;
  for (const candidate of input.slice(-MAX_HISTORY_MESSAGES)) {
    if (!candidate || typeof candidate !== "object") continue;
    const role = candidate.role === "user" || candidate.role === "assistant" ? candidate.role : null;
    const content = typeof candidate.content === "string" ? candidate.content.trim() : "";
    if (!role || !content || content.length > MAX_HISTORY_CHARS) continue;
    if (chars + content.length > MAX_HISTORY_CHARS) break;
    chars += content.length;
    selected.push({
      ...(validUuid(candidate.id) ? { id: candidate.id } : {}),
      role,
      content,
      isComplete: true,
    });
  }
  return selected;
}

function ndjson(event: AgentStreamEvent) {
  return `${JSON.stringify(event)}\n`;
}

/**
 * Execute a temporary turn without creating threads, messages, agent events,
 * memory jobs, or indexes. The browser owns the temporary transcript and
 * sends the bounded transcript back for each turn.
 */
export function createTemporaryAgentResponse(input: TemporaryAgentInput): Response {
  const runId = crypto.randomUUID();
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  const model = input.model ?? getConfiguredModelName();
  const history = boundedHistory(input.history);
  const currentUser: AgentMessage = { id: userMessageId, role: "user", content: input.content, isComplete: true };
  const allMessages = [...history, currentUser];
  const baseContext = createAgentContext({
    profileId: input.profileId,
    profileLabel: input.profileLabel,
    threadId: input.temporaryId,
    threadTitle: "Temporary chat",
    temporaryChat: true,
    browserTimezone: input.timezone,
    currentUserMessageId: userMessageId,
    agentRunId: runId,
    canonicalMemory: { globalRevision: 0, items: [] },
    memoryChangeHint: { afterRevision: 0, throughRevision: 0, changes: [] },
    memoryControls: { savedMemoryEnabled: false, referenceHistoryEnabled: false },
    budgetedContext: {
      threadSummary: null,
      pinnedNotes: [],
      savedMemoryPrompt: "",
      referenceHistoryPrompt: "",
      targetedRetrievalPrompt: "",
    },
  });
  const estimator = createTokenEstimator({ provider: "openrouter", model });
  let assembly;
  try {
    assembly = assembleTokenBudgetedContext({
      provider: "openrouter",
      model,
      systemPrompt: buildDynamicSystemPrompt(baseContext),
      toolSchemas: getInternalToolSchemaDescriptors(),
      currentUser,
      messages: allMessages,
      estimator,
    });
  } catch (error) {
    const message = error instanceof ContextBudgetError
      ? error.message
      : "The temporary chat could not prepare this turn.";
    return new Response(JSON.stringify({ error: message }), { status: 413, headers: { "Content-Type": "application/json" } });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let sequence = 0;
      let closed = false;
      const send = (event: Record<string, unknown>) => {
        if (closed) return;
        const next = { ...event, version: AGENT_STREAM_PROTOCOL, sequence: ++sequence, runId } as AgentStreamEvent;
        controller.enqueue(encoder.encode(ndjson(next)));
      };

      try {
        send({ type: "run_started", requestId: input.requestId, userMessageId, assistantMessageId, at: new Date().toISOString() });
        for await (const event of streamAgentEvents({
          context: baseContext,
          messages: assembly.messages,
          memoryRetrieval: createDisabledMemoryRetrieval(),
          memoryMutation: createDisabledMemoryMutation(),
          memoryArchive: createDisabledMemoryArchive(),
          threadOverviewReader: createTemporaryThreadOverviewReader(),
          savedMemoryEnabled: false,
          referenceHistoryEnabled: false,
        })) {
          if (event.type === "usage_observed") continue;
          if (event.type === "text_delta") {
            send({ type: "text_delta", text: event.text });
          } else if (event.type === "tool_started") {
            send({ type: "tool_started", toolCallId: event.toolCallId, toolName: event.toolName, input: sanitizeForEvent(event.input), ...(event.statusMessage ? { statusMessage: event.statusMessage } : {}) });
          } else {
            send({ type: "tool_finished", toolCallId: event.toolCallId, toolName: event.toolName, output: sanitizeForEvent(event.output), ok: event.ok, ...(event.statusMessage ? { statusMessage: event.statusMessage } : {}) });
          }
        }
        send({ type: "completed", assistantMessageId, at: new Date().toISOString() });
      } catch (error) {
        const failure = safeFailure(error);
        send({ type: "failed", code: failure.code, message: failure.message, partial: false, at: new Date().toISOString() });
      } finally {
        closed = true;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Accel-Buffering": "no",
      "X-Iris-Temporary": "true",
    },
  });
}

export function validateTemporaryId(value: unknown) {
  return validUuid(value) ? value : crypto.randomUUID();
}

export function sanitizeTemporaryHistory(value: unknown): TemporaryHistoryInput | undefined {
  return Array.isArray(value) ? boundedHistory(value as TemporaryHistoryInput).map((message) => ({ id: message.id, role: message.role, content: message.content })) : undefined;
}

export function temporaryHistoryMessageCount(value: unknown) {
  return boundedHistory(sanitizeTemporaryHistory(value)).length;
}
