import "server-only";

import type { AgentStreamEvent } from "@/server/agent/protocol";

export type PersistedTraceEvent = {
  id?: string;
  profileId?: string;
  threadId?: string;
  runId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt?: string;
};

export type EvaluationTraceReport = {
  runId: string | null;
  status: "completed" | "failed" | "incomplete";
  classification: {
    agentTurns: number;
    providerRequests: number;
    backgroundRequests: number;
    toolCalls: number;
    toolResults: number;
  };
  stream: {
    eventCount: number;
    eventTypes: string[];
    assistantText: string;
    assistantTextLength: number;
    toolCallIds: string[];
    failure: { code: string; partial: boolean } | null;
  };
  persisted: {
    eventCount: number;
    eventTypes: string[];
    modelCalls: Array<{
      invocationId: string;
      invocationOrdinal: number | null;
      executionKind: string | null;
      provider: string | null;
      model: string | null;
      status: "completed" | "failed" | "started";
      durationMs: number | null;
      requestId: string | null;
      usage: Record<string, unknown> | null;
      finishReason: string | null;
      stopReason: string | null;
    }>;
    tools: Array<{
      toolCallId: string;
      toolName: string;
      status: "completed" | "failed" | "started";
      ok: boolean | null;
    }>;
    actions: Array<Record<string, unknown>>;
    assistant: {
      status: "completed" | "partial" | "missing";
      contentHash: string | null;
      contentLength: number | null;
      assistantMessageId: string | null;
    };
  };
};

export type EvaluationTraceEventLoader = (runId: string) => Promise<readonly PersistedTraceEvent[]>;

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function integer(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function parsePublicEvent(line: string): AgentStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed === "[DONE]") return null;
  const json = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  if (!json || json === "[DONE]") return null;
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    if (typeof value.type !== "string" || typeof value.sequence !== "number") return null;
    return value as unknown as AgentStreamEvent;
  } catch {
    return null;
  }
}

async function readResponseEvents(response: Response) {
  if (!response.body) return [] as AgentStreamEvent[];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: AgentStreamEvent[] = [];
  const consume = (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parsePublicEvent(line);
      if (event) events.push(event);
    }
  };

  while (true) {
    const next = await reader.read();
    if (next.done) break;
    consume(decoder.decode(next.value, { stream: true }));
  }
  consume(decoder.decode());
  const finalEvent = parsePublicEvent(buffer);
  if (finalEvent) events.push(finalEvent);
  return events;
}

function eventTypes(events: readonly { type: string }[]) {
  return [...new Set(events.map((event) => event.type))];
}

function safeStatus(value: unknown): "completed" | "failed" | "started" {
  return value === "failed" || value === "completed" ? value : "started";
}

function asActions(payload: Record<string, unknown>) {
  const output = object(payload.output);
  const actions = Array.isArray(output.actions) ? output.actions : [];
  return actions.flatMap((action) => {
    const value = object(action);
    const safe: Record<string, unknown> = {};
    for (const key of ["type", "threadId", "messageId", "title", "label", "url"]) {
      if (typeof value[key] === "string") safe[key] = value[key];
    }
    return Object.keys(safe).length > 0 ? [safe] : [];
  });
}

function buildPersistedReport(events: readonly PersistedTraceEvent[]) {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  const modelStarts = ordered.filter((event) => event.type === "model_call_started");
  const modelCalls = modelStarts.map((start) => {
    const payload = object(start.payload);
    const invocationId = string(payload.invocationId) ?? `sequence:${start.sequence}`;
    const end = ordered.find((event) =>
      (event.type === "model_call_completed" || event.type === "model_call_failed")
      && string(event.payload.invocationId) === invocationId,
    );
    const endPayload = object(end?.payload);
    const status: "completed" | "failed" | "started" = end?.type === "model_call_completed" ? "completed" : end?.type === "model_call_failed" ? "failed" : "started";
    return {
      invocationId,
      invocationOrdinal: integer(payload.invocationOrdinal),
      executionKind: string(payload.executionKind),
      provider: string(payload.provider),
      model: string(payload.model),
      status,
      durationMs: integer(endPayload.durationMs),
      requestId: string(endPayload.requestId),
      usage: Object.keys(object(endPayload.usage)).length > 0 ? object(endPayload.usage) : null,
      finishReason: string(endPayload.finishReason),
      stopReason: string(endPayload.stopReason),
    };
  });

  const toolStarts = ordered.filter((event) => event.type === "tool_call");
  const tools = toolStarts.map((start) => {
    const payload = object(start.payload);
    const toolCallId = string(payload.toolCallId) ?? `sequence:${start.sequence}`;
    const result = ordered.find((event) => event.type === "tool_result" && string(event.payload.toolCallId) === toolCallId);
    return {
      toolCallId,
      toolName: string(payload.toolName) ?? "unknown_tool",
      status: result ? result.payload.ok === true ? "completed" : "failed" : "started",
      ok: result ? result.payload.ok === true : null,
    } as const;
  });
  const assistantCompleted = [...ordered].reverse().find((event) => event.type === "assistant_completed");
  const assistantPartial = [...ordered].reverse().find((event) => event.type === "assistant_partial");
  const assistantPayload = object(assistantCompleted?.payload ?? assistantPartial?.payload);
  return {
    eventCount: ordered.length,
    eventTypes: eventTypes(ordered),
    modelCalls,
    tools,
    actions: ordered.filter((event) => event.type === "tool_result").flatMap((event) => asActions(event.payload)),
    assistant: {
      status: assistantCompleted ? "completed" : assistantPartial ? "partial" : "missing",
      contentHash: string(assistantPayload.contentHash),
      contentLength: integer(assistantPayload.contentLength),
      assistantMessageId: string(assistantPayload.assistantMessageId),
    } as const,
  };
}

/**
 * Consume the production NDJSON/SSE-compatible response and join it with the
 * incrementally persisted run events. This is intentionally an evaluator
 * utility, not a product UI path: it reports traces without exposing prompts.
 */
export async function readEvaluationTrace(response: Response, loadPersistedEvents?: EvaluationTraceEventLoader): Promise<EvaluationTraceReport> {
  const streamEvents = await readResponseEvents(response);
  const started = streamEvents.find((event) => event.type === "run_started");
  const runId = started?.runId ?? streamEvents.find((event) => typeof event.runId === "string")?.runId ?? null;
  const persisted = runId && loadPersistedEvents ? await loadPersistedEvents(runId) : [];
  const persistedReport = buildPersistedReport(persisted);
  const streamText = streamEvents.filter((event) => event.type === "text_delta").map((event) => event.text).join("");
  const failed = streamEvents.find((event) => event.type === "failed");
  const streamTools = streamEvents.filter((event) => event.type === "tool_started");
  const providerRequests = persistedReport.modelCalls.length;
  const backgroundRequests = persistedReport.modelCalls.filter((call) => call.executionKind?.startsWith("background_")).length;
  const agentTurns = persisted.filter((event) => event.type === "run_started" && object(event.payload).executionKind !== "background").length;
  const status = failed ? "failed" : streamEvents.some((event) => event.type === "completed") ? "completed" : "incomplete";
  return {
    runId,
    status,
    classification: {
      agentTurns,
      providerRequests,
      backgroundRequests,
      toolCalls: persistedReport.tools.length || streamTools.length,
      toolResults: persisted.filter((event) => event.type === "tool_result").length,
    },
    stream: {
      eventCount: streamEvents.length,
      eventTypes: eventTypes(streamEvents),
      assistantText: streamText,
      assistantTextLength: streamText.length,
      toolCallIds: streamTools.flatMap((event) => "toolCallId" in event && typeof event.toolCallId === "string" ? [event.toolCallId] : []),
      failure: failed && "code" in failed && typeof failed.code === "string"
        ? { code: failed.code, partial: "partial" in failed && failed.partial === true }
        : null,
    },
    persisted: persistedReport,
  };
}

export function exportEvaluationTrace(report: EvaluationTraceReport) {
  return `${JSON.stringify(report, null, 2)}\n`;
}
