import { describe, expect, it } from "vitest";
import { AGENT_STREAM_PROTOCOL, type AgentStreamEvent } from "@/server/agent/protocol";
import {
  AgentStreamParser,
  assistantStreamPhase,
  createStreamEventBuffer,
  createStreamState,
  failStreamState,
  groupToolEvents,
  reduceAgentStream,
  startOptimisticRun,
  summarizeToolResult,
} from "@/lib/agent-stream";
import type { Message } from "@/lib/types";

const ids = {
  threadId: "00000000-0000-4000-8000-000000000001",
  profileId: "profile-a" as const,
  user: "pending-user",
  assistant: "pending-assistant",
};

function event(value: { type: AgentStreamEvent["type"]; runId: string; [key: string]: unknown }, sequence = 1) {
  return { ...value, version: AGENT_STREAM_PROTOCOL, sequence } as AgentStreamEvent;
}

function runningState() {
  const userMessage: Message = { id: ids.user, threadId: ids.threadId, profileId: ids.profileId, role: "user", content: "Hello", createdAt: "2026-08-15T12:00:00.000Z" };
  const assistantMessage: Message = { id: ids.assistant, threadId: ids.threadId, profileId: ids.profileId, role: "assistant", content: "", createdAt: "2026-08-15T12:00:00.000Z", isComplete: false };
  return startOptimisticRun(createStreamState(), { userMessage, assistantMessage });
}

describe("agent stream parser", () => {
  it("parses events split at arbitrary NDJSON and UTF-8 boundaries", () => {
    const parser = new AgentStreamParser();
    const line = `${JSON.stringify(event({ type: "text_delta", runId: "run-1", text: "café" }))}\n`;
    const bytes = new TextEncoder().encode(line);
    const accentStart = new TextEncoder().encode(line.slice(0, line.indexOf("é"))).length;
    const first = bytes.slice(0, accentStart + 1);
    const second = bytes.slice(accentStart + 1, accentStart + 2);
    const third = bytes.slice(accentStart + 2);
    expect(parser.push(first)).toEqual([]);
    expect(parser.push(second)).toEqual([]);
    expect(parser.push(third)).toHaveLength(1);
    expect(bytes.length).toBeGreaterThan(first.length + second.length);
  });

  it("rejects old and unknown protocol versions", () => {
    const parser = new AgentStreamParser();
    const oldEvent = { type: "delta", text: "old" };
    const unknownEvent = { ...event({ type: "text_delta", runId: "run-1", text: "ignored" }), type: "future_event" };
    const currentEvent = event({ type: "text_delta", runId: "run-1", text: "accepted" });
    const data = `${JSON.stringify(oldEvent)}\n${JSON.stringify({ ...currentEvent, version: "iris.agent.stream.v0" })}\n${JSON.stringify(unknownEvent)}\n${JSON.stringify(currentEvent)}\n`;
    expect(parser.push(data)).toEqual([currentEvent]);
  });
});

describe("agent stream reducer", () => {
  it("batches text deltas in order until the scheduled frame flushes", () => {
    const scheduled: Array<() => void> = [];
    const batches: AgentStreamEvent[][] = [];
    const buffer = createStreamEventBuffer((events) => batches.push(events), {
      schedule: (callback) => {
        scheduled.push(callback);
        return callback;
      },
      cancel: () => undefined,
    });
    const first = event({ type: "text_delta", runId: "run-1", text: "Hello" }, 2);
    const second = event({ type: "text_delta", runId: "run-1", text: " world" }, 3);

    buffer.push([first]);
    buffer.push([second]);
    expect(batches).toHaveLength(0);
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    expect(batches).toEqual([[first, second]]);
  });

  it("flushes a terminal event with all preceding text and drops cancelled work", () => {
    const batches: AgentStreamEvent[][] = [];
    const buffer = createStreamEventBuffer((events) => batches.push(events), {
      schedule: (callback) => callback,
      cancel: () => undefined,
    });
    const text = event({ type: "text_delta", runId: "run-1", text: "Done" }, 2);
    const completed = event({ type: "completed", runId: "run-1", assistantMessageId: "assistant-1", at: "later" }, 3);
    buffer.push([text, completed]);
    buffer.flush();
    expect(batches).toEqual([[text, completed]]);

    buffer.push([event({ type: "text_delta", runId: "run-1", text: "ignored" }, 4)]);
    buffer.cancel();
    expect(batches).toHaveLength(1);
  });

  it("moves cleanly from thinking to visible text and keeps failures incomplete", () => {
    const emptyAssistant: Message = { id: ids.assistant, threadId: ids.threadId, profileId: ids.profileId, role: "assistant", content: "", createdAt: "2026-08-15T12:00:00.000Z", isComplete: false };
    const partialAssistant = { ...emptyAssistant, content: "Visible" };
    const completeAssistant = { ...partialAssistant, isComplete: true };
    expect(assistantStreamPhase(emptyAssistant)).toBe("thinking");
    expect(assistantStreamPhase(partialAssistant, true)).toBe("streaming");
    expect(assistantStreamPhase(partialAssistant)).toBe("incomplete");
    expect(assistantStreamPhase(completeAssistant)).toBe("complete");

    let failed = reduceAgentStream(runningState(), event({
      type: "run_started", runId: "run-1", requestId: "request-1", userMessageId: "user-1", assistantMessageId: "assistant-1", at: "now",
    }));
    failed = reduceAgentStream(failed, event({ type: "failed", runId: "run-1", code: "AGENT_RUN_FAILED", message: "Could not start", partial: false, at: "later" }, 2));
    expect(failed.status).toBe("failed");
    expect(failed.messages).toHaveLength(1);
  });

  it("replaces optimistic IDs with authoritative run IDs", () => {
    const next = reduceAgentStream(runningState(), event({
      type: "run_started",
      runId: "run-1",
      requestId: "request-1",
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      at: "2026-08-15T12:00:01.000Z",
    }));
    expect(next.messages.map((message) => message.id)).toEqual(["user-1", "assistant-1"]);
    expect(next.userMessageId).toBe("user-1");
    expect(next.assistantMessageId).toBe("assistant-1");
    expect(next.runId).toBe("run-1");
  });

  it("marks a completed assistant response complete", () => {
    let next = reduceAgentStream(runningState(), event({
      type: "run_started", runId: "run-1", requestId: "request-1", userMessageId: "user-1", assistantMessageId: "assistant-1", at: "now",
    }));
    next = reduceAgentStream(next, event({ type: "text_delta", runId: "run-1", text: "Done" }, 2));
    next = reduceAgentStream(next, event({ type: "completed", runId: "run-1", assistantMessageId: "assistant-1", at: "later" }, 3));
    expect(next.messages[1]).toMatchObject({ id: "assistant-1", content: "Done", isComplete: true, agentRunId: "run-1" });
    expect(next.status).toBe("completed");
  });

  it("ignores duplicate and late events by stream sequence", () => {
    let next = reduceAgentStream(runningState(), event({
      type: "run_started", runId: "run-1", requestId: "request-1", userMessageId: "user-1", assistantMessageId: "assistant-1", at: "now",
    }, 1));
    next = reduceAgentStream(next, event({ type: "text_delta", runId: "run-1", text: "Once" }, 2));
    next = reduceAgentStream(next, event({ type: "text_delta", runId: "run-1", text: "Twice" }, 2));
    expect(next.messages[1].content).toBe("Once");
    next = reduceAgentStream(next, event({ type: "completed", runId: "run-1", assistantMessageId: "assistant-1", at: "later" }, 3));
    next = reduceAgentStream(next, event({ type: "text_delta", runId: "run-1", text: " after terminal" }, 4));
    expect(next.messages[1].content).toBe("Once");
  });

  it("keeps partial text incomplete but removes an empty placeholder on failure", () => {
    let partial = reduceAgentStream(runningState(), event({
      type: "run_started", runId: "run-1", requestId: "request-1", userMessageId: "user-1", assistantMessageId: "assistant-1", at: "now",
    }));
    partial = reduceAgentStream(partial, event({ type: "text_delta", runId: "run-1", text: "Partial" }, 2));
    partial = reduceAgentStream(partial, event({ type: "failed", runId: "run-1", code: "AGENT_RUN_FAILED", message: "Could not finish", partial: true, at: "later" }, 3));
    expect(partial.messages[1]).toMatchObject({ content: "Partial", isComplete: false });

    const empty = reduceAgentStream(runningState(), event({
      type: "failed", runId: "run-1", code: "AGENT_RUN_FAILED", message: "Could not start", partial: false, at: "later",
    }));
    expect(empty.messages).toHaveLength(1);
    expect(empty.messages[0].role).toBe("user");
    expect(failStreamState(runningState(), "Network error").messages).toHaveLength(1);
  });

  it("groups live and persisted tool call/result pairs by run and call ID", () => {
    const replay = groupToolEvents([
      { runId: "run-2", sequence: 2, type: "tool_result", toolCallId: "call-2", toolName: "thread_overview", output: { found: true, title: "A" }, ok: true, createdAt: "2026-08-15T12:00:02.000Z" },
      { runId: "run-2", sequence: 1, type: "tool_call", toolCallId: "call-2", toolName: "thread_overview", input: {}, createdAt: "2026-08-15T12:00:01.000Z" },
    ]);
    expect(replay).toEqual([expect.objectContaining({ runId: "run-2", toolCallId: "call-2", status: "succeeded", input: {}, output: { found: true, title: "A" } })]);

    let live = reduceAgentStream(runningState(), event({ type: "tool_started", runId: "run-1", toolCallId: "call-1", toolName: "current_time", input: {} }, 1));
    live = reduceAgentStream(live, event({ type: "tool_finished", runId: "run-1", toolCallId: "call-1", toolName: "current_time", output: { timezone: "UTC" }, ok: false }, 2));
    expect(live.toolActivities).toEqual([expect.objectContaining({ runId: "run-1", toolCallId: "call-1", status: "failed" })]);
  });

  it("summarizes JSON-string results from the built-in tools", () => {
    expect(summarizeToolResult({
      runId: "run-1", toolCallId: "call-1", toolName: "current_time", status: "succeeded",
      output: JSON.stringify({ serverNow: "2026-08-15T12:00:00.000Z", timezone: "UTC" }),
    })).toContain("UTC");
    expect(summarizeToolResult({
      runId: "run-1", toolCallId: "call-2", toolName: "thread_overview", status: "succeeded",
      output: JSON.stringify({ found: true, title: "Runtime test", messageCount: 4 }),
    })).toBe("Runtime test · 4 messages");
  });
});
