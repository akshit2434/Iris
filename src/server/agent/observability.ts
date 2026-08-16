import "server-only";

import { createHash } from "node:crypto";

import { sanitizeForEvent, type SafeJson } from "@/server/agent/protocol";

/**
 * A model invocation is deliberately separate from an agent run. One user
 * turn can contain several provider requests while a background worker can
 * make a single request without having an interactive run.
 */
export type TraceExecutionKind =
  | "interactive_agent"
  | "temporary_agent"
  | "background_reference_history"
  | "background_memory_consolidation"
  | "background_thread_continuity"
  | "title_generation"
  | "evaluation";

export type TraceEventType =
  | "model_call_started"
  | "model_call_completed"
  | "model_call_failed"
  | "assistant_completed"
  | "assistant_partial";

export type TraceUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens?: number | null;
  reasoningOutputTokens?: number | null;
};

export type ModelCallHandle = {
  invocationId: string;
  invocationOrdinal: number;
  startedAt: string;
  startedAtMs: number;
  model: string;
  provider: string;
  executionKind: TraceExecutionKind;
};

export type TraceEventWriter = (type: TraceEventType, payload: Record<string, unknown>) => Promise<void>;

export type AgentTraceRecorder = {
  startModelCall(input?: { model?: string; provider?: string; executionKind?: TraceExecutionKind }): Promise<ModelCallHandle>;
  completeModelCall(input: {
    handle: ModelCallHandle;
    response?: unknown;
  }): Promise<void>;
  failModelCall(input: {
    handle: ModelCallHandle;
    error?: unknown;
  }): Promise<void>;
  assistantCompleted(input: {
    assistantMessageId: string;
    content: string;
    estimatedTokens?: number | null;
    isComplete?: boolean;
  }): Promise<void>;
  assistantPartial(input: {
    assistantMessageId: string;
    content: string;
    estimatedTokens?: number | null;
  }): Promise<void>;
};

type RecorderOptions = {
  append: TraceEventWriter;
  model: string;
  provider?: string;
  executionKind?: TraceExecutionKind;
  now?: () => Date;
  idFactory?: () => string;
};

function finiteNonNegative(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function responseMetadata(value: unknown) {
  const message = record(value);
  const metadata = record(message.response_metadata);
  const usageMetadata = record(message.usage_metadata);
  const responseUsage = record(metadata.usage);
  const tokenUsage = record(metadata.tokenUsage);
  return { message, metadata, usageMetadata, responseUsage, tokenUsage };
}

/** Extract provider usage without retaining prompts or raw provider metadata. */
export function extractTraceUsage(value: unknown): TraceUsage | null {
  const { message, metadata, usageMetadata, responseUsage, tokenUsage } = responseMetadata(value);
  const inputTokens = finiteNonNegative(usageMetadata.input_tokens)
    ?? finiteNonNegative(responseUsage.input_tokens)
    ?? finiteNonNegative(responseUsage.prompt_tokens)
    ?? finiteNonNegative(tokenUsage.inputTokens)
    ?? finiteNonNegative(tokenUsage.promptTokens);
  const outputTokens = finiteNonNegative(usageMetadata.output_tokens)
    ?? finiteNonNegative(responseUsage.output_tokens)
    ?? finiteNonNegative(responseUsage.completion_tokens)
    ?? finiteNonNegative(tokenUsage.outputTokens)
    ?? finiteNonNegative(tokenUsage.completionTokens);
  const totalTokens = finiteNonNegative(usageMetadata.total_tokens)
    ?? finiteNonNegative(responseUsage.total_tokens)
    ?? finiteNonNegative(tokenUsage.totalTokens)
    ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  if (inputTokens === null && outputTokens === null && totalTokens === null) return null;

  const inputDetails = record(usageMetadata.input_token_details);
  const outputDetails = record(usageMetadata.output_token_details);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(finiteNonNegative(inputDetails.cache_read) !== null ? { cachedInputTokens: finiteNonNegative(inputDetails.cache_read) } : {}),
    ...(finiteNonNegative(outputDetails.reasoning) !== null ? { reasoningOutputTokens: finiteNonNegative(outputDetails.reasoning) } : {}),
  };
}

function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() ?? null;
}

/** Provider response identifiers and stop metadata are safe, bounded scalars. */
export function extractTraceResponseMetadata(value: unknown) {
  const { message, metadata } = responseMetadata(value);
  const choices = Array.isArray(metadata.choices) ? metadata.choices : [];
  const firstChoice = record(choices[0]);
  const requestId = firstString(
    message.id,
    metadata.id,
    metadata.request_id,
    metadata.requestId,
    metadata.response_id,
    metadata.responseId,
  );
  const finishReason = firstString(
    metadata.finish_reason,
    metadata.finishReason,
    firstChoice.finish_reason,
    firstChoice.finishReason,
  );
  const stopReason = firstString(
    metadata.stop_reason,
    metadata.stopReason,
    metadata.reason,
    firstChoice.stop_reason,
    firstChoice.stopReason,
  );
  return {
    requestId: requestId?.slice(0, 300) ?? null,
    finishReason: finishReason?.slice(0, 120) ?? null,
    stopReason: stopReason?.slice(0, 120) ?? null,
    usage: extractTraceUsage(value),
  };
}

function errorCode(error: unknown) {
  const name = error instanceof Error ? error.name : "Error";
  return name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "Error";
}

function hashContent(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

function boundedModel(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 200) : fallback;
}

/**
 * Create a lossless event recorder. Writer failures are swallowed because
 * telemetry must never alter the agent's model/tool behavior.
 */
export function createAgentTraceRecorder(options: RecorderOptions): AgentTraceRecorder {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => crypto.randomUUID());
  const provider = options.provider ?? "openrouter";
  const executionKind = options.executionKind ?? "interactive_agent";
  let invocationOrdinal = 0;

  async function write(type: TraceEventType, payload: Record<string, unknown>) {
    try {
      await options.append(type, payload);
    } catch {
      // Persistence is best effort. The runtime still has the public stream
      // and raw assistant message as fallback evidence when telemetry is down.
    }
  }

  return {
    async startModelCall(input = {}) {
      const startedAtDate = now();
      const handle: ModelCallHandle = {
        invocationId: idFactory(),
        invocationOrdinal: ++invocationOrdinal,
        startedAt: startedAtDate.toISOString(),
        startedAtMs: startedAtDate.getTime(),
        model: boundedModel(input.model, options.model),
        provider: input.provider ?? provider,
        executionKind: input.executionKind ?? executionKind,
      };
      await write("model_call_started", {
        invocationId: handle.invocationId,
        invocationOrdinal: handle.invocationOrdinal,
        startedAt: handle.startedAt,
        model: handle.model,
        provider: handle.provider,
        executionKind: handle.executionKind,
      });
      return handle;
    },

    async completeModelCall(input) {
      const endedAtDate = now();
      const metadata = extractTraceResponseMetadata(input.response);
      await write("model_call_completed", {
        invocationId: input.handle.invocationId,
        invocationOrdinal: input.handle.invocationOrdinal,
        startedAt: input.handle.startedAt,
        completedAt: endedAtDate.toISOString(),
        durationMs: Math.max(0, endedAtDate.getTime() - input.handle.startedAtMs),
        model: input.handle.model,
        provider: input.handle.provider,
        executionKind: input.handle.executionKind,
        requestId: metadata.requestId,
        finishReason: metadata.finishReason,
        stopReason: metadata.stopReason,
        ...(metadata.usage ? { usage: metadata.usage } : {}),
      });
    },

    async failModelCall(input) {
      const failedAtDate = now();
      await write("model_call_failed", {
        invocationId: input.handle.invocationId,
        invocationOrdinal: input.handle.invocationOrdinal,
        startedAt: input.handle.startedAt,
        failedAt: failedAtDate.toISOString(),
        durationMs: Math.max(0, failedAtDate.getTime() - input.handle.startedAtMs),
        model: input.handle.model,
        provider: input.handle.provider,
        executionKind: input.handle.executionKind,
        errorCode: errorCode(input.error),
      });
    },

    async assistantCompleted(input) {
      await write("assistant_completed", {
        assistantMessageId: input.assistantMessageId,
        contentHash: hashContent(input.content),
        contentLength: input.content.length,
        estimatedTokens: finiteNonNegative(input.estimatedTokens),
        isComplete: input.isComplete !== false,
      });
    },

    async assistantPartial(input) {
      await write("assistant_partial", {
        assistantMessageId: input.assistantMessageId,
        contentHash: hashContent(input.content),
        contentLength: input.content.length,
        estimatedTokens: finiteNonNegative(input.estimatedTokens),
        isComplete: false,
      });
    },
  };
}

/** Bounded projection for evaluation/export code. */
export function safeTracePayload(value: unknown): SafeJson {
  return sanitizeForEvent(value);
}
