import { describe, expect, it } from "vitest";
import { FakeToolCallingModel } from "langchain";
import {
  createAgentTraceRecorder,
  extractTraceResponseMetadata,
} from "@/server/agent/observability";
import { createAgentContext } from "@/server/agent/context";
import { streamAgentEvents } from "@/server/agent";
import { exportEvaluationTrace, readEvaluationTrace, type PersistedTraceEvent } from "@/server/agent/evaluation-trace";

const context = createAgentContext({
  profileId: "profile-a",
  profileLabel: "Profile A",
  threadId: "00000000-0000-4000-8000-000000000001",
  threadTitle: "Trace test",
  browserTimezone: "UTC",
  now: new Date("2026-08-16T00:00:00.000Z"),
});

describe("agent observability", () => {
  it("records provider metadata without retaining prompts", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    let nowMs = Date.parse("2026-08-16T00:00:00.000Z");
    const trace = createAgentTraceRecorder({
      model: "openai/test-model",
      provider: "openrouter",
      idFactory: () => "invocation-1",
      now: () => new Date(nowMs),
      append: async (type, payload) => { events.push({ type, payload }); },
    });

    const handle = await trace.startModelCall();
    nowMs += 125;
    await trace.completeModelCall({
      handle,
      response: {
        id: "provider-request-1",
        content: "answer",
        usage_metadata: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
        response_metadata: { finish_reason: "stop" },
        hiddenPrompt: "must never be persisted",
      },
    });
    await trace.assistantCompleted({ assistantMessageId: "assistant-1", content: "answer", estimatedTokens: 7 });

    expect(events.map((event) => event.type)).toEqual([
      "model_call_started",
      "model_call_completed",
      "assistant_completed",
    ]);
    expect(events[1]?.payload).toMatchObject({
      invocationId: "invocation-1",
      invocationOrdinal: 1,
      durationMs: 125,
      requestId: "provider-request-1",
      finishReason: "stop",
      usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
    });
    expect(JSON.stringify(events)).not.toContain("must never be persisted");
    expect(events[2]?.payload).toMatchObject({ contentLength: 6, isComplete: true });
    expect(events[2]?.payload).toHaveProperty("contentHash");
  });

  it("preserves partial assistant evidence before a later run failure", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const trace = createAgentTraceRecorder({
      model: "openai/test-model",
      idFactory: () => "invocation-failed",
      append: async (type, payload) => { events.push({ type, payload }); },
    });
    const handle = await trace.startModelCall();
    await trace.failModelCall({ handle, error: new Error("provider disconnected") });
    await trace.assistantPartial({ assistantMessageId: "assistant-partial", content: "half an answer", estimatedTokens: 4 });
    events.push({ type: "run_failed", payload: { partial: true } });

    expect(events.map((event) => event.type)).toEqual([
      "model_call_started",
      "model_call_failed",
      "assistant_partial",
      "run_failed",
    ]);
    expect(events[2]?.payload).toMatchObject({
      assistantMessageId: "assistant-partial",
      contentLength: 14,
      isComplete: false,
    });
  });

  it("traces every model turn in a multi-tool loop while preserving tool linkage", async () => {
    const persisted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const trace = createAgentTraceRecorder({
      model: "openai/test-model",
      idFactory: (() => {
        let index = 0;
        return () => `invocation-${++index}`;
      })(),
      append: async (type, payload) => { persisted.push({ type, payload }); },
    });
    const events = [];
    for await (const event of streamAgentEvents({
      model: new FakeToolCallingModel({
        toolCalls: [
          [{ id: "call-time", name: "thread_overview", args: {} }],
          [{ id: "call-time-2", name: "thread_overview", args: {} }],
          [],
        ],
      }),
      context,
      threadOverviewReader: async () => ({
        title: "Trace test",
        createdAt: "2026-08-15T00:00:00.000Z",
        updatedAt: "2026-08-16T00:00:00.000Z",
        messageCount: 2,
      }),
      observability: trace,
      messages: [{ role: "user", content: "inspect the thread twice" }],
    })) {
      events.push(event);
    }

    const modelStarts = persisted.filter((event) => event.type === "model_call_started");
    const modelEnds = persisted.filter((event) => event.type === "model_call_completed");
    expect(modelStarts.length).toBeGreaterThanOrEqual(2);
    expect(modelEnds.length).toBe(modelStarts.length);
    expect(modelStarts.map((event) => event.payload.invocationOrdinal)).toEqual(
      modelStarts.map((_event, index) => index + 1),
    );
    expect(events.filter((event) => event.type === "tool_started").map((event) => event.toolCallId)).toEqual(["call-time", "call-time-2"]);
    expect(events.some((event) => event.type === "text_delta")).toBe(true);
  });

  it("replays a real streamed turn into a deterministic trace report", async () => {
    const persisted: PersistedTraceEvent[] = [
      { runId: "run-1", sequence: 1, type: "run_started", payload: {} },
      { runId: "run-1", sequence: 2, type: "model_call_started", payload: { invocationId: "inv-1", invocationOrdinal: 1, executionKind: "interactive_agent", provider: "openrouter", model: "openai/test-model" } },
      { runId: "run-1", sequence: 3, type: "model_call_completed", payload: { invocationId: "inv-1", durationMs: 50, requestId: "req-1", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 }, finishReason: "stop" } },
      { runId: "run-1", sequence: 4, type: "tool_call", payload: { toolCallId: "call-search", toolName: "history_preflight" } },
      { runId: "run-1", sequence: 5, type: "tool_result", payload: { toolCallId: "call-search", toolName: "history_preflight", ok: true, output: { actions: [{ type: "open_message", threadId: "thread-1", messageId: "message-1" }] } } },
      { runId: "run-1", sequence: 6, type: "assistant_completed", payload: { assistantMessageId: "assistant-1", contentHash: "a".repeat(64), contentLength: 12, isComplete: true } },
      { runId: "run-1", sequence: 7, type: "run_completed", payload: {} },
    ];
    const response = new Response([
      JSON.stringify({ version: "iris.agent.stream.v1", type: "run_started", sequence: 1, runId: "run-1", requestId: "req-1", userMessageId: "user-1", assistantMessageId: "assistant-1", at: "now" }),
      JSON.stringify({ version: "iris.agent.stream.v1", type: "tool_started", sequence: 2, runId: "run-1", toolCallId: "call-search", toolName: "history_preflight", input: {} }),
      JSON.stringify({ version: "iris.agent.stream.v1", type: "text_delta", sequence: 3, runId: "run-1", text: "Found it." }),
      JSON.stringify({ version: "iris.agent.stream.v1", type: "completed", sequence: 4, runId: "run-1", assistantMessageId: "assistant-1", at: "later" }),
    ].join("\n") + "\n", { headers: { "Content-Type": "application/x-ndjson" } });
    const report = await readEvaluationTrace(response, async (runId) => {
      expect(runId).toBe("run-1");
      return persisted;
    });

    expect(report).toMatchObject({
      runId: "run-1",
      status: "completed",
      classification: { agentTurns: 1, providerRequests: 1, backgroundRequests: 0, toolCalls: 1, toolResults: 1 },
      stream: { assistantText: "Found it.", assistantTextLength: 9 },
      persisted: { assistant: { status: "completed", assistantMessageId: "assistant-1" } },
    });
    expect(report.persisted.actions).toEqual([{ type: "open_message", threadId: "thread-1", messageId: "message-1" }]);
    expect(exportEvaluationTrace(report)).toContain('"providerRequests": 1');
  });

  it("extracts request, stop and usage metadata from provider responses", () => {
    expect(extractAgentResponse()).toEqual({
      requestId: "req-9",
      finishReason: "tool_calls",
      stopReason: "end_turn",
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    });
  });
});

function extractAgentResponse() {
  return extractTraceResponseMetadata({
    id: "req-9",
    usage_metadata: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    response_metadata: { finish_reason: "tool_calls", stop_reason: "end_turn" },
  });
}

