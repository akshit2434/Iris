import { describe, expect, it } from "vitest";
import {
  assembleTokenBudgetedContext,
  attachActualUsage,
  ContextBudgetError,
  NORMAL_CONTEXT_ENVELOPE,
} from "@/server/agent/context-assembler";
import { createTokenEstimator } from "@/server/agent/token-budget";

const estimator = createTokenEstimator({ provider: "openrouter", model: "openai/test-model" });

function message(id: string, role: "user" | "assistant" | "tool", content: string) {
  return { id, role, content, isComplete: true } as const;
}

describe("token-budgeted context assembly", () => {
  it("keeps the current turn complete and trims older history by whole conversation units", () => {
    const current = message("current", "user", "Please use the latest context.");
    const first = message("first", "user", "old user " + "x".repeat(1_200));
    const firstReply = message("first-reply", "assistant", "old reply " + "y".repeat(1_200));
    const second = message("second", "user", "recent user");
    const secondReply = message("second-reply", "assistant", "recent reply");
    const assembled = assembleTokenBudgetedContext({
      provider: "openrouter",
      model: "openai/test-model",
      systemPrompt: "system time",
      toolSchemas: [{ name: "search", parameters: { type: "object" } }],
      currentUser: current,
      messages: [first, firstReply, second, secondReply, current],
      threadSummary: "continuity",
      pinnedNotes: ["one constraint"],
      savedMemoryPrompt: "saved preference",
      targetedRetrievalPrompt: "retrieved source",
      estimator,
      normalEnvelopeTokens: 1_200,
      burstEnvelopeTokens: 2_400,
      outputReserveTokens: 100,
      safetyReserveTokens: 100,
    });

    expect(assembled.messages.at(-1)).toEqual(current);
    expect(assembled.messages.some((entry) => entry.id === "second")).toBe(true);
    expect(assembled.messages.some((entry) => entry.id === "second-reply")).toBe(true);
    expect(assembled.messages.some((entry) => entry.id === "first"))
      .toBe(assembled.messages.some((entry) => entry.id === "first-reply"));
    expect(assembled.ledger.components.map((entry) => entry.name)).toEqual([
      "system_time",
      "tool_schemas",
      "current_user",
      "thread_summary",
      "saved_memory",
      "reference_history",
      "targeted_retrieval",
      "recent_raw_tail",
    ]);
    expect(assembled.ledger.estimatedTotalWithUncertaintyTokens)
      .toBeLessThanOrEqual(assembled.ledger.envelopeTokens);
  });

  it("uses the configured burst only when the mandatory current request does not fit normally", () => {
    const current = message("current", "user", "A very large current request ".repeat(240));
    const assembled = assembleTokenBudgetedContext({
      provider: "openrouter",
      model: "openai/test-model",
      systemPrompt: "system",
      currentUser: current,
      messages: [current],
      estimator,
      normalEnvelopeTokens: 500,
      burstEnvelopeTokens: 4_000,
      outputReserveTokens: 100,
      safetyReserveTokens: 100,
    });

    expect(assembled.ledger.burstUsed).toBe(true);
    expect(assembled.ledger.burstReason).toBe("current_turn_does_not_fit_normal");
    expect(assembled.messages.at(-1)?.content).toBe(current.content);
  });

  it("starts raw history after a durable continuity checkpoint", () => {
    const assembled = assembleTokenBudgetedContext({
      provider: "openrouter",
      model: "openai/test-model",
      systemPrompt: "system",
      currentUser: message("current", "user", "new"),
      messages: [
        message("old", "user", "already summarized"),
        message("checkpoint", "assistant", "checkpoint response"),
        message("after", "user", "new detail"),
        message("current", "user", "new"),
      ],
      compactedThroughMessageId: "checkpoint",
      threadSummary: "summary of old",
      estimator,
    });
    expect(assembled.messages.map((entry) => entry.id)).toEqual(["after", "current"]);
    expect(assembled.ledger.messages.map((entry) => entry.id)).toEqual(["after", "current"]);
  });

  it("never truncates a current turn beyond the configured burst", () => {
    const current = message("current", "user", "too large ".repeat(20_000));
    expect(() => assembleTokenBudgetedContext({
      provider: "openrouter",
      model: "openai/test-model",
      systemPrompt: "system",
      currentUser: current,
      messages: [current],
      estimator,
      normalEnvelopeTokens: NORMAL_CONTEXT_ENVELOPE,
      burstEnvelopeTokens: 2_000,
    })).toThrowError(ContextBudgetError);
  });

  it("uses a conservative provider-aware estimator without network calls", () => {
    expect(estimator.metadata).toEqual({
      provider: "openrouter",
      model: "openai/test-model",
      mode: "conservative",
      version: "iris-conservative-v1",
    });
    const text = "hello 👋";
    expect(estimator.estimateText(text)).toBeGreaterThan(0);
    expect(estimator.estimateJson({ role: "user", content: text })).toBeGreaterThan(estimator.estimateText(text));
  });

  it("records provider usage as a numeric calibration hook only", () => {
    const assembled = assembleTokenBudgetedContext({
      provider: "openrouter",
      model: "openai/test-model",
      systemPrompt: "system",
      currentUser: message("current", "user", "hello"),
      messages: [message("current", "user", "hello")],
      estimator,
    });
    const calibrated = attachActualUsage(assembled.ledger, {
      inputTokens: 40,
      outputTokens: 7,
      totalTokens: 47,
    });
    expect(calibrated.calibration).toMatchObject({ actualInputTokens: 40, deltaTokens: expect.any(Number), ratio: expect.any(Number) });
    expect(JSON.stringify(calibrated)).not.toContain("hello");
  });
});
