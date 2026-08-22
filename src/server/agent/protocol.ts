export const AGENT_STREAM_PROTOCOL = "iris.agent.stream.v1" as const;

export type SafeJson =
  | string
  | number
  | boolean
  | null
  | SafeJson[]
  | { [key: string]: SafeJson };

export type AgentStreamEvent =
  | {
      version: typeof AGENT_STREAM_PROTOCOL;
      type: "run_started";
      sequence: number;
      runId: string;
      /** Present for first-message creation so the client can adopt the persisted route. */
      threadId?: string;
      requestId: string;
      userMessageId: string;
      assistantMessageId: string;
      at: string;
    }
  | {
      version: typeof AGENT_STREAM_PROTOCOL;
      type: "text_delta";
      sequence: number;
      runId: string;
      text: string;
    }
  | {
      version: typeof AGENT_STREAM_PROTOCOL;
      type: "tool_started";
      sequence: number;
      runId: string;
      toolCallId: string;
      toolName: string;
      input: SafeJson;
      statusMessage?: string;
    }
  | {
      version: typeof AGENT_STREAM_PROTOCOL;
      type: "tool_finished";
      sequence: number;
      runId: string;
      toolCallId: string;
      toolName: string;
      output: SafeJson;
      ok: boolean;
      statusMessage?: string;
    }
  | {
      version: typeof AGENT_STREAM_PROTOCOL;
      type: "title_updated";
      sequence: number;
      runId: string;
      title: string;
    }
  | {
      version: typeof AGENT_STREAM_PROTOCOL;
      type: "loop_ledger";
      sequence: number;
      runId: string;
      created: string[];
      closed: string[];
    }
  | {
      version: typeof AGENT_STREAM_PROTOCOL;
      type: "completed";
      sequence: number;
      runId: string;
      assistantMessageId: string;
      at: string;
    }
  | {
      version: typeof AGENT_STREAM_PROTOCOL;
      type: "failed";
      sequence: number;
      runId: string;
      code: string;
      message: string;
      partial: boolean;
      at: string;
    };

export function sanitizeForEvent(value: unknown, depth = 0): SafeJson {
  // Canonical-memory provenance nests as result -> sources -> source ->
  // action. Keep that bounded shape intact so a validated source can survive
  // streaming and persistence as an actionable UI card.
  if (depth > 6) return "[truncated]";
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return typeof value === "string" ? value.slice(0, 4000) : value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeForEvent(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, item]) => [key.slice(0, 200), sanitizeForEvent(item, depth + 1)]),
    );
  }
  return String(value).slice(0, 4000);
}

/** Optional short progress copy for long-running tools; never expose raw markup or control text. */
export function sanitizeStatusMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[<>`*_#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return normalized || undefined;
}

export function safeFailure(error: unknown): { code: string; message: string } {
  const name = error instanceof Error ? error.name : "Error";
  const knownCodes = new Set(["AbortError", "TimeoutError", "OpenRouterError", "ToolInvocationError"]);
  return {
    code: knownCodes.has(name) ? name : "AGENT_RUN_FAILED",
    message: "The assistant could not complete this run.",
  };
}
