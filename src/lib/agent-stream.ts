import type { AgentStreamEvent, SafeJson } from "@/server/agent/protocol";
import { AGENT_STREAM_PROTOCOL } from "@/server/agent/protocol";
import type { Message, PersistedToolEvent, SafeToolJson, ToolActivity } from "@/lib/types";

export type StreamStatus = "idle" | "running" | "completed" | "failed";

export type StreamState = {
  messages: Message[];
  toolActivities: ToolActivity[];
  userMessageId: string | null;
  assistantMessageId: string | null;
  runId: string | null;
  lastSequence: number;
  status: StreamStatus;
  errorMessage: string | null;
  title: string | null;
};

export type AssistantStreamPhase = "thinking" | "streaming" | "complete" | "incomplete";

type StreamEventBufferOptions = {
  schedule?: (callback: () => void) => unknown;
  cancel?: (handle: unknown) => void;
};

type StreamEventBuffer = {
  push: (events: readonly AgentStreamEvent[]) => void;
  flush: () => void;
  cancel: () => void;
};

function scheduleStreamFrame(callback: () => void) {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    return window.requestAnimationFrame(callback);
  }
  return setTimeout(callback, 0);
}

function cancelStreamFrame(handle: unknown) {
  if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function" && typeof handle === "number") {
    window.cancelAnimationFrame(handle);
    return;
  }
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

/**
 * Batch provider events into one reducer commit per animation frame. A frame
 * flush keeps text deltas ordered while preventing a React render per token.
 * The scheduler is injectable so ordering and terminal flushes stay testable.
 */
export function createStreamEventBuffer(
  onFlush: (events: AgentStreamEvent[]) => void,
  options: StreamEventBufferOptions = {},
): StreamEventBuffer {
  const schedule = options.schedule ?? scheduleStreamFrame;
  const cancel = options.cancel ?? cancelStreamFrame;
  let pending: AgentStreamEvent[] = [];
  let frame: unknown = null;
  let cancelled = false;

  function flush() {
    if (cancelled) return;
    if (frame !== null) {
      cancel(frame);
      frame = null;
    }
    if (pending.length === 0) return;
    const events = pending;
    pending = [];
    onFlush(events);
  }

  return {
    push(events) {
      if (cancelled || events.length === 0) return;
      pending.push(...events);
      if (frame === null) frame = schedule(() => {
        frame = null;
        flush();
      });
    },
    flush,
    cancel() {
      if (cancelled) return;
      if (frame !== null) cancel(frame);
      frame = null;
      pending = [];
      cancelled = true;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasString(value: Record<string, unknown>, key: string): value is Record<string, unknown> & Record<typeof key, string> {
  return typeof value[key] === "string" && value[key].length > 0;
}

function hasNumber(value: Record<string, unknown>, key: string): value is Record<string, unknown> & Record<typeof key, number> {
  return typeof value[key] === "number" && Number.isInteger(value[key]) && value[key] > 0;
}

/** Validate the public stream envelope before the UI acts on an event. */
export function parseAgentStreamEvent(value: unknown): AgentStreamEvent | null {
  if (!isRecord(value) || value.version !== AGENT_STREAM_PROTOCOL || !hasString(value, "type") || !hasNumber(value, "sequence") || !hasString(value, "runId")) {
    return null;
  }

  switch (value.type) {
    case "run_started":
      return hasString(value, "requestId") && hasString(value, "userMessageId") && hasString(value, "assistantMessageId") && hasString(value, "at")
        ? value as unknown as AgentStreamEvent
        : null;
    case "text_delta":
      return typeof value.text === "string" ? value as unknown as AgentStreamEvent : null;
    case "tool_started":
      return hasString(value, "toolCallId") && hasString(value, "toolName") && "input" in value
        ? value as unknown as AgentStreamEvent
        : null;
    case "tool_finished":
      return hasString(value, "toolCallId") && hasString(value, "toolName") && "output" in value && typeof value.ok === "boolean"
        ? value as unknown as AgentStreamEvent
        : null;
    case "completed":
      return hasString(value, "assistantMessageId") && hasString(value, "at")
        ? value as unknown as AgentStreamEvent
        : null;
    case "title_updated":
      return hasString(value, "title") ? value as unknown as AgentStreamEvent : null;
    case "failed":
      return hasString(value, "code") && hasString(value, "message") && typeof value.partial === "boolean" && hasString(value, "at")
        ? value as unknown as AgentStreamEvent
        : null;
    default:
      return null;
  }
}

/**
 * Incremental NDJSON parser. TextDecoder keeps a UTF-8 code point split across
 * network chunks intact; lines are validated only after their newline arrives.
 */
export class AgentStreamParser {
  private readonly decoder = new TextDecoder();
  private buffer = "";

  push(chunk: Uint8Array | string): AgentStreamEvent[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  finish(): AgentStreamEvent[] {
    this.buffer += this.decoder.decode();
    return this.drain(true);
  }

  private drain(final: boolean) {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    if (final && this.buffer.trim()) {
      lines.push(this.buffer);
      this.buffer = "";
    }

    const events: AgentStreamEvent[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = parseAgentStreamEvent(JSON.parse(trimmed) as unknown);
        if (event) events.push(event);
      } catch {
        // A malformed line cannot be trusted as a stream event. Keep parsing
        // later lines so one bad provider chunk cannot corrupt the transcript.
      }
    }
    return events;
  }
}

function toolKey(runId: string, toolCallId: string) {
  return `${runId}:${toolCallId}`;
}

function upsertToolActivity(activities: ToolActivity[], next: ToolActivity) {
  const index = activities.findIndex((activity) => toolKey(activity.runId, activity.toolCallId) === toolKey(next.runId, next.toolCallId));
  if (index === -1) return [...activities, next];
  const updated = activities.slice();
  updated[index] = {
    ...updated[index],
    ...next,
    input: next.input !== undefined ? next.input : updated[index].input,
    output: next.output !== undefined ? next.output : updated[index].output,
    startedAt: next.startedAt !== undefined ? next.startedAt : updated[index].startedAt,
    finishedAt: next.finishedAt !== undefined ? next.finishedAt : updated[index].finishedAt,
  };
  return updated;
}

function persistedToolActivity(event: PersistedToolEvent): ToolActivity {
  return {
    runId: event.runId,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    input: event.input,
    output: event.output,
    status: event.type === "tool_call" ? "running" : event.ok ? "succeeded" : "failed",
    startedAt: event.type === "tool_call" ? event.createdAt : undefined,
    finishedAt: event.type === "tool_result" ? event.createdAt : undefined,
  };
}

/** Rebuild compact call/result rows from persisted, already-sanitized events. */
export function groupToolEvents(events: readonly PersistedToolEvent[]): ToolActivity[] {
  const grouped = new Map<string, ToolActivity>();
  for (const event of [...events].sort((left, right) => {
    // Sequence numbers are scoped to a run. Preserve each run's sequence and
    // use event time plus run ID as deterministic tie-breakers across runs.
    if (left.runId === right.runId) return left.sequence - right.sequence;
    const byTime = left.createdAt.localeCompare(right.createdAt);
    return byTime !== 0 ? byTime : left.runId.localeCompare(right.runId);
  })) {
    const key = toolKey(event.runId, event.toolCallId);
    const existing = grouped.get(key);
    const next = persistedToolActivity(event);
    grouped.set(key, existing ? {
      ...existing,
      ...next,
      input: next.input !== undefined ? next.input : existing.input,
      output: next.output !== undefined ? next.output : existing.output,
      startedAt: next.startedAt !== undefined ? next.startedAt : existing.startedAt,
      finishedAt: next.finishedAt !== undefined ? next.finishedAt : existing.finishedAt,
    } : next);
  }
  return [...grouped.values()];
}

function applyToolEvent(activities: ToolActivity[], event: Extract<AgentStreamEvent, { type: "tool_started" | "tool_finished" }>) {
  const next: ToolActivity = event.type === "tool_started"
    ? {
        runId: event.runId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input as SafeToolJson,
        status: "running",
      }
    : {
        runId: event.runId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        output: event.output as SafeToolJson,
        status: event.ok ? "succeeded" : "failed",
      };
  return upsertToolActivity(activities, next);
}

function replaceMessageId(messages: Message[], oldId: string | null, newId: string) {
  if (!oldId || oldId === newId) return messages;
  const alreadyExists = messages.some((message) => message.id === newId);
  return messages.flatMap((message) => message.id === oldId
    ? alreadyExists ? [] : [{ ...message, id: newId }]
    : [message]);
}

function updateAssistant(messages: Message[], assistantMessageId: string | null, update: (message: Message) => Message) {
  if (!assistantMessageId) return messages;
  return messages.map((message) => message.id === assistantMessageId ? update(message) : message);
}

export function createStreamState(input?: {
  messages?: Message[];
  toolActivities?: ToolActivity[];
}): StreamState {
  return {
    messages: input?.messages ?? [],
    toolActivities: input?.toolActivities ?? [],
    userMessageId: null,
    assistantMessageId: null,
    runId: null,
    lastSequence: 0,
    status: "idle",
    errorMessage: null,
    title: null,
  };
}

export function startOptimisticRun(state: StreamState, input: {
  userMessage: Message;
  assistantMessage: Message;
}): StreamState {
  return {
    ...state,
    messages: [...state.messages, input.userMessage, input.assistantMessage],
    userMessageId: input.userMessage.id,
    assistantMessageId: input.assistantMessage.id,
    runId: null,
    lastSequence: 0,
    status: "running",
    errorMessage: null,
  };
}

export function assistantStreamPhase(message: Pick<Message, "role" | "content" | "isComplete">, isActive = false): AssistantStreamPhase | null {
  if (message.role !== "assistant") return null;
  if (message.isComplete === false) {
    if (!message.content) return "thinking";
    return isActive ? "streaming" : "incomplete";
  }
  return "complete";
}

export function reduceAgentStream(state: StreamState, event: AgentStreamEvent): StreamState {
  // A reconnect/retry can replay an already-consumed event. Sequence numbers
  // make the reducer idempotent and prevent duplicate text/tool rows.
  if (event.sequence <= state.lastSequence) return state;
  if (state.status === "completed" || state.status === "failed") return state;
  if (state.runId && event.runId !== state.runId) return state;
  const nextBase = { ...state, lastSequence: event.sequence };

  if (event.type === "run_started") {
    let messages = replaceMessageId(nextBase.messages, nextBase.userMessageId, event.userMessageId);
    messages = replaceMessageId(messages, nextBase.assistantMessageId, event.assistantMessageId);
    messages = messages.map((message) => message.id === event.userMessageId || message.id === event.assistantMessageId
      ? { ...message, agentRunId: event.runId, ...(message.role === "assistant" ? { isComplete: false } : {}) }
      : message);
    return { ...nextBase, messages, userMessageId: event.userMessageId, assistantMessageId: event.assistantMessageId, runId: event.runId, status: "running", errorMessage: null };
  }

  const runId = nextBase.runId ?? event.runId;

  if (event.type === "text_delta") {
    return {
      ...nextBase,
      runId,
      status: "running",
      messages: updateAssistant(state.messages, state.assistantMessageId, (message) => ({ ...message, content: message.content + event.text, agentRunId: event.runId, isComplete: false })),
    };
  }

  if (event.type === "title_updated") {
    return { ...nextBase, runId, title: event.title };
  }

  if (event.type === "tool_started" || event.type === "tool_finished") {
    return { ...nextBase, runId, status: "running", toolActivities: applyToolEvent(nextBase.toolActivities, event) };
  }

  if (event.type === "completed") {
    const messages = replaceMessageId(nextBase.messages, nextBase.assistantMessageId, event.assistantMessageId);
    return {
      ...nextBase,
      messages: updateAssistant(messages, event.assistantMessageId, (message) => ({ ...message, agentRunId: event.runId, isComplete: true })),
      assistantMessageId: event.assistantMessageId,
      runId,
      status: "completed",
      errorMessage: null,
    };
  }

  const assistant = state.assistantMessageId ? state.messages.find((message) => message.id === state.assistantMessageId) : null;
  const hasPartial = Boolean(assistant?.content.trim());
  const messages = hasPartial
    ? updateAssistant(state.messages, state.assistantMessageId, (message) => ({ ...message, isComplete: false, agentRunId: event.runId }))
    : state.messages.filter((message) => message.id !== state.assistantMessageId);
  return { ...nextBase, messages, runId, status: "failed", errorMessage: event.message };
}

export function failStreamState(state: StreamState, message: string): StreamState {
  const assistant = state.assistantMessageId ? state.messages.find((item) => item.id === state.assistantMessageId) : null;
  const hasPartial = Boolean(assistant?.content.trim());
  return {
    ...state,
    messages: hasPartial
      ? updateAssistant(state.messages, state.assistantMessageId, (item) => ({ ...item, isComplete: false }))
      : state.messages.filter((item) => item.id !== state.assistantMessageId),
    status: "failed",
    errorMessage: message,
  };
}

export function toolActivitiesForRun(activities: readonly ToolActivity[], runId: string | null | undefined) {
  return runId ? activities.filter((activity) => activity.runId === runId) : [];
}

export function summarizeToolActivity(activities: readonly ToolActivity[]) {
  const failed = activities.filter((activity) => activity.status === "failed").length;
  const running = activities.filter((activity) => activity.status === "running").length;
  if (running > 0) return `Using ${activities.length} ${activities.length === 1 ? "tool" : "tools"}`;
  if (failed > 0) return `${failed} ${failed === 1 ? "tool" : "tools"} failed`;
  if (activities.length === 1) return `Used ${toolLabel(activities[0].toolName).toLocaleLowerCase()}`;
  return `Used ${activities.length} tools`;
}

export function toolLabel(toolName: string) {
  if (toolName === "current_time") return "Current time";
  if (toolName === "thread_overview") return "Thread overview";
  return toolName.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shortText(value: string) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117).trimEnd()}…` : compact;
}

function objectOutput(value: SafeToolJson | undefined): Record<string, SafeToolJson> | null {
  if (isRecord(value)) return value as Record<string, SafeToolJson>;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed as Record<string, SafeToolJson> : null;
  } catch {
    return null;
  }
}

export function summarizeToolResult(activity: ToolActivity) {
  if (activity.status === "running") return "Working…";
  if (activity.status === "failed") return "Couldn’t complete";
  const output = activity.output;
  const structuredOutput = objectOutput(output);
  if (activity.toolName === "current_time" && structuredOutput) {
    const now = typeof structuredOutput.serverNow === "string" ? structuredOutput.serverNow : "";
    const timezone = typeof structuredOutput.timezone === "string" ? structuredOutput.timezone : "";
    if (now && timezone) {
      const date = new Date(now);
      return `${Number.isNaN(date.valueOf()) ? now : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} · ${timezone}`;
    }
  }
  if (activity.toolName === "thread_overview" && structuredOutput) {
    if (structuredOutput.found === false) return "No thread details available";
    const title = typeof structuredOutput.title === "string" ? shortText(structuredOutput.title) : "Current thread";
    const count = typeof structuredOutput.messageCount === "number" ? `${structuredOutput.messageCount} messages` : "Saved thread";
    return `${title} · ${count}`;
  }
  if (typeof output === "string") return shortText(output) || "Done";
  return "Result ready";
}

export function toolDetail(activity: ToolActivity) {
  if (activity.toolName === "current_time" || activity.toolName === "thread_overview") return null;
  const value: SafeJson | undefined = activity.output ?? activity.input;
  if (!value || typeof value !== "object") return null;
  return JSON.stringify(value, null, 2).slice(0, 1600);
}
