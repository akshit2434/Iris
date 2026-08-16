import type { MessageRole } from "@/lib/types";
import { createTokenEstimator, estimateUncertainty, type TokenEstimator, type TokenizerMetadata } from "@/server/agent/token-budget";

export const NORMAL_CONTEXT_ENVELOPE = 65_536;
export const MAX_CONTEXT_BURST_ENVELOPE = 131_072;
export const OUTPUT_TOKEN_RESERVE = 8_192;
export const SAFETY_TOKEN_RESERVE = 4_096;
export const UNCERTAINTY_RATE = 0.1;

export const RECENT_TAIL_TARGET = 20_000;
export const THREAD_SUMMARY_TARGET = 6_000;
export const MEMORY_HISTORY_TARGET = 6_000;
export const RETRIEVAL_TARGET = 8_000;

export type AssemblerMessage = {
  id?: string;
  role: MessageRole;
  content: string;
  isComplete?: boolean;
  createdAt?: string;
  /** Optional provider-specific correlation metadata for tool units. */
  unitId?: string;
  toolCallId?: string;
  toolResultFor?: string;
};

export type ContextComponentName =
  | "system_time"
  | "tool_schemas"
  | "current_user"
  | "thread_summary"
  | "saved_memory"
  | "reference_history"
  | "targeted_retrieval"
  | "recent_raw_tail";

export type ContextComponentLedger = {
  name: ContextComponentName;
  estimatedTokens: number;
  selectedTokens: number;
  targetTokens: number | null;
  sourceCount: number;
  selectedCount: number;
  truncated: boolean;
  omitted: boolean;
};

export type MessageTokenLedgerEntry = {
  id: string | null;
  role: MessageRole;
  estimatedTokens: number;
  selected: boolean;
};

export type ActualTokenUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens?: number | null;
  reasoningOutputTokens?: number | null;
};

export type ContextTokenLedger = {
  version: "iris-context-ledger-v1";
  provider: string;
  model: string;
  tokenizer: TokenizerMetadata;
  normalEnvelopeTokens: number;
  burstEnvelopeTokens: number;
  envelopeTokens: number;
  outputReserveTokens: number;
  safetyReserveTokens: number;
  uncertaintyRate: number;
  uncertaintyReserveTokens: number;
  inputBudgetTokens: number;
  /** Estimated serialized input before older raw units are trimmed. */
  projectedInputTokens: number;
  estimatedInputTokens: number;
  estimatedTotalWithUncertaintyTokens: number;
  burstUsed: boolean;
  burstReason: "current_turn_does_not_fit_normal" | "none";
  components: ContextComponentLedger[];
  messages: MessageTokenLedgerEntry[];
  actualUsage?: ActualTokenUsage;
  calibration?: {
    estimatedInputTokens: number;
    actualInputTokens: number | null;
    deltaTokens: number | null;
    ratio: number | null;
  };
};

export type BudgetedPromptContext = {
  threadSummary: string | null;
  pinnedNotes: string[];
  savedMemoryPrompt: string;
  referenceHistoryPrompt: string;
  targetedRetrievalPrompt: string;
};

export type ContextAssembly = {
  messages: AssemblerMessage[];
  prompt: BudgetedPromptContext;
  ledger: ContextTokenLedger;
};

export type ContextAssemblyInput = {
  provider: string;
  model: string;
  systemPrompt: string;
  toolSchemas?: readonly unknown[];
  currentUser: AssemblerMessage;
  messages: readonly AssemblerMessage[];
  continuityThroughMessageId?: string | null;
  threadSummary?: string | null;
  pinnedNotes?: readonly string[];
  savedMemoryPrompt?: string;
  referenceHistoryPrompt?: string;
  targetedRetrievalPrompt?: string;
  estimator?: TokenEstimator;
  normalEnvelopeTokens?: number;
  burstEnvelopeTokens?: number;
  outputReserveTokens?: number;
  safetyReserveTokens?: number;
  uncertaintyRate?: number;
};

type ConversationUnit = {
  index: number;
  messages: AssemblerMessage[];
  tokens: number;
  complete: boolean;
};

export type ContinuitySourceSpan = {
  messages: AssemblerMessage[];
  messageIds: string[];
  startMessageId: string | null;
  endMessageId: string | null;
  startOrdinal: number | null;
  endOrdinal: number | null;
  estimatedTokens: number;
  recentTailTokens: number;
};

export class ContextBudgetError extends Error {
  readonly code = "context_budget_exceeded";
  readonly reason: "current_user_turn_too_large" | "mandatory_components_too_large";

  constructor(reason: ContextBudgetError["reason"]) {
    super(reason === "current_user_turn_too_large"
      ? "The current user turn is larger than the supported context burst."
      : "The required system, tool, and current-turn context is larger than the supported context burst.");
    this.name = "ContextBudgetError";
    this.reason = reason;
  }
}

/** Attach provider usage as a calibration hook without retaining prompt text. */
export function attachActualUsage(ledger: ContextTokenLedger, actualUsage: ActualTokenUsage): ContextTokenLedger {
  const actualInputTokens = actualUsage.inputTokens;
  return {
    ...ledger,
    actualUsage,
    calibration: {
      estimatedInputTokens: ledger.estimatedInputTokens,
      actualInputTokens,
      deltaTokens: actualInputTokens === null ? null : actualInputTokens - ledger.estimatedInputTokens,
      ratio: actualInputTokens === null || ledger.estimatedInputTokens === 0
        ? null
        : actualInputTokens / ledger.estimatedInputTokens,
    },
  };
}

function clampEnvelope(value: number | undefined, fallback: number, maximum: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value as number), maximum));
}

function safeInputBudget(envelope: number, outputReserve: number, safetyReserve: number, uncertaintyRate: number) {
  const fixed = Math.max(0, envelope - Math.max(0, outputReserve) - Math.max(0, safetyReserve));
  return Math.max(0, Math.floor(fixed / (1 + Math.max(0, uncertaintyRate))));
}

function textEstimate(estimator: TokenEstimator, component: ContextComponentName, value: string) {
  return value ? estimator.estimateJson({ component, content: value }) : 0;
}

function schemaEstimate(estimator: TokenEstimator, schemas: readonly unknown[]) {
  return schemas.length > 0 ? estimator.estimateJson({ type: "tools", tools: schemas }) : 0;
}

function messageEstimate(estimator: TokenEstimator, message: AssemblerMessage) {
  return estimator.estimateMessage({ role: message.role, content: message.content });
}

function groupConversationUnits(messages: readonly AssemblerMessage[], estimator: TokenEstimator): ConversationUnit[] {
  const units: ConversationUnit[] = [];
  let current: ConversationUnit | null = null;
  for (const message of messages) {
    const startsUnit = message.role === "user" || current === null;
    if (startsUnit) {
      current = { index: units.length, messages: [], tokens: 0, complete: true };
      units.push(current);
    }
    const unit = current;
    if (!unit) continue;
    unit.messages.push(message);
    unit.tokens += messageEstimate(estimator, message);
    if (message.isComplete === false) unit.complete = false;
  }
  return units;
}

function selectRecentUnits(units: readonly ConversationUnit[], budget: number) {
  const selected = new Set<number>();
  let used = 0;
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index];
    if (!unit || !unit.complete) break;
    // A tail is a contiguous suffix. Skipping a large recent unit and then
    // selecting an older unit would silently make the model forget the newer
    // conversation while retaining stale history.
    if (unit.tokens > budget - used) break;
    selected.add(unit.index);
    used += unit.tokens;
  }
  return { selected, used };
}

/**
 * Choose the oldest complete conversation units that can be summarized while
 * retaining a token-budgeted recent tail. A unit starts with a user message
 * and includes every following assistant/tool message until the next user
 * message. Incomplete units are never handed to a summarizer.
 */
export function selectContinuitySourceSpan(input: {
  messages: readonly AssemblerMessage[];
  continuityThroughMessageId?: string | null;
  currentUserMessageId?: string | null;
  estimator: TokenEstimator;
  recentTailTokens: number;
}): ContinuitySourceSpan | null {
  const checkpointIndex = input.continuityThroughMessageId
    ? input.messages.findIndex((message) => message.id === input.continuityThroughMessageId)
    : -1;
  const startIndex = checkpointIndex >= 0 ? checkpointIndex + 1 : 0;
  const sourceWithOrdinals = input.messages
    .map((message, index) => ({ message, index }))
    .filter(({ message, index }) => index >= startIndex && message.id !== input.currentUserMessageId);
  const source = sourceWithOrdinals.map(({ message }) => message);
  const ordinalByMessage = new Map(sourceWithOrdinals.map(({ message, index }) => [message, index] as const));
  const units = groupConversationUnits(source, input.estimator);
  if (units.length < 2) return null;

  const tailBudget = Math.max(0, Math.floor(input.recentTailTokens));
  let tailStart = units.length;
  let tailTokens = 0;
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index];
    if (!unit?.complete) break;
    if (tailTokens > 0 && unit.tokens > tailBudget - tailTokens) break;
    if (tailTokens === 0 && unit.tokens > tailBudget) {
      // The most recent complete unit is retained as a whole even when it is
      // larger than the nominal tail. It must never be split.
      tailStart = index;
      tailTokens = unit.tokens;
      break;
    }
    tailStart = index;
    tailTokens += unit.tokens;
  }
  if (tailStart <= 0 || tailStart > units.length) return null;

  const eligibleUnits = units.slice(0, tailStart);
  if (eligibleUnits.some((unit) => !unit.complete)) {
    // Only summarize the complete prefix before the first incomplete unit.
    const firstIncomplete = eligibleUnits.findIndex((unit) => !unit.complete);
    if (firstIncomplete === 0) return null;
    eligibleUnits.splice(firstIncomplete);
  }
  const selectedMessages = eligibleUnits.flatMap((unit) => unit.messages);
  if (selectedMessages.length === 0) return null;
  const startMessage = selectedMessages[0];
  const endMessage = selectedMessages.at(-1);
  const messageIds = selectedMessages.flatMap((message) => message.id ? [message.id] : []);
  return {
    messages: selectedMessages,
    messageIds,
    startMessageId: startMessage?.id ?? null,
    endMessageId: endMessage?.id ?? null,
    startOrdinal: startMessage ? ordinalByMessage.get(startMessage) ?? null : null,
    endOrdinal: endMessage ? ordinalByMessage.get(endMessage) ?? null : null,
    estimatedTokens: eligibleUnits.reduce((sum, unit) => sum + unit.tokens, 0),
    recentTailTokens: tailTokens,
  };
}

function fitText(estimator: TokenEstimator, value: string, component: ContextComponentName, budget: number) {
  if (!value || budget <= 0) return { text: "", tokens: 0, truncated: Boolean(value) };
  const fullTokens = textEstimate(estimator, component, value);
  if (fullTokens <= budget) return { text: value, tokens: fullTokens, truncated: false };

  // Reserve a small component wrapper. The estimator, rather than a character
  // threshold, determines the final boundary.
  const wrapperCost = Math.max(0, fullTokens - estimator.estimateText(value));
  const fitted = estimator.truncateText(value, Math.max(0, budget - wrapperCost));
  let text = fitted.text;
  while (text && textEstimate(estimator, component, text) > budget) {
    const next = estimator.truncateText(text, Math.max(0, estimator.estimateText(text) - 1)).text;
    if (next === text) break;
    text = next;
  }
  const selectedTokens = text ? textEstimate(estimator, component, text) : 0;
  return { text, tokens: selectedTokens, truncated: true };
}

function fitNotes(estimator: TokenEstimator, notes: readonly string[], budget: number) {
  const selected: string[] = [];
  let used = 0;
  for (const note of notes) {
    const value = note.trim();
    if (!value) continue;
    const candidate = textEstimate(estimator, "thread_summary", value);
    if (candidate <= budget - used) {
      selected.push(value);
      used += candidate;
    }
  }
  return { selected, used };
}

function addComponent(
  components: ContextComponentLedger[],
  entry: ContextComponentLedger,
) {
  components.push(entry);
}

/**
 * Assemble the exact bounded state sent to the model. Required system/tool/
 * current-turn components are never silently trimmed. Older raw history is
 * selected only as complete conversation units; a unit containing tool calls
 * and results is retained or dropped as a whole.
 */
export function assembleTokenBudgetedContext(input: ContextAssemblyInput): ContextAssembly {
  const estimator = input.estimator ?? createTokenEstimator({ provider: input.provider, model: input.model });
  const normalEnvelope = clampEnvelope(input.normalEnvelopeTokens, NORMAL_CONTEXT_ENVELOPE, MAX_CONTEXT_BURST_ENVELOPE);
  const burstEnvelope = clampEnvelope(input.burstEnvelopeTokens, MAX_CONTEXT_BURST_ENVELOPE, MAX_CONTEXT_BURST_ENVELOPE);
  const outputReserve = Math.max(0, Math.floor(input.outputReserveTokens ?? OUTPUT_TOKEN_RESERVE));
  const safetyReserve = Math.max(0, Math.floor(input.safetyReserveTokens ?? SAFETY_TOKEN_RESERVE));
  const uncertaintyRate = Math.max(0, input.uncertaintyRate ?? UNCERTAINTY_RATE);

  const systemTokens = textEstimate(estimator, "system_time", input.systemPrompt);
  const toolsTokens = schemaEstimate(estimator, input.toolSchemas ?? []);
  const currentTokens = messageEstimate(estimator, input.currentUser);
  const mandatoryTokens = systemTokens + toolsTokens + currentTokens;
  const normalInputBudget = safeInputBudget(normalEnvelope, outputReserve, safetyReserve, uncertaintyRate);
  const burstInputBudget = safeInputBudget(burstEnvelope, outputReserve, safetyReserve, uncertaintyRate);
  const burstUsed = mandatoryTokens > normalInputBudget;
  const inputBudget = burstUsed ? burstInputBudget : normalInputBudget;

  if (currentTokens > inputBudget) throw new ContextBudgetError("current_user_turn_too_large");
  if (mandatoryTokens > inputBudget) throw new ContextBudgetError("mandatory_components_too_large");

  const components: ContextComponentLedger[] = [];
  addComponent(components, {
    name: "system_time",
    estimatedTokens: systemTokens,
    selectedTokens: systemTokens,
    targetTokens: null,
    sourceCount: input.systemPrompt ? 1 : 0,
    selectedCount: input.systemPrompt ? 1 : 0,
    truncated: false,
    omitted: !input.systemPrompt,
  });
  addComponent(components, {
    name: "tool_schemas",
    estimatedTokens: toolsTokens,
    selectedTokens: toolsTokens,
    targetTokens: null,
    sourceCount: input.toolSchemas?.length ?? 0,
    selectedCount: input.toolSchemas?.length ?? 0,
    truncated: false,
    omitted: toolsTokens === 0,
  });
  addComponent(components, {
    name: "current_user",
    estimatedTokens: currentTokens,
    selectedTokens: currentTokens,
    targetTokens: null,
    sourceCount: 1,
    selectedCount: 1,
    truncated: false,
    omitted: false,
  });

  const stateBudget = Math.max(0, inputBudget - mandatoryTokens);
  const recentTarget = Math.min(RECENT_TAIL_TARGET, Math.floor(stateBudget * 0.5));
  const summaryTarget = Math.min(THREAD_SUMMARY_TARGET, Math.floor(stateBudget * 0.15));
  const memoryTarget = Math.min(MEMORY_HISTORY_TARGET, Math.floor(stateBudget * 0.15));
  const retrievalTarget = Math.min(RETRIEVAL_TARGET, Math.floor(stateBudget * 0.2));

  const summaryValue = input.threadSummary?.trim() ?? "";
  const summary = fitText(estimator, summaryValue, "thread_summary", summaryTarget);
  let noteBudget = Math.max(0, summaryTarget - summary.tokens);
  const notes = fitNotes(estimator, input.pinnedNotes ?? [], noteBudget);
  const selectedSummaryTokens = summary.tokens + notes.used;
  addComponent(components, {
    name: "thread_summary",
    estimatedTokens: textEstimate(estimator, "thread_summary", summaryValue) + (input.pinnedNotes ?? []).reduce((sum, note) => sum + textEstimate(estimator, "thread_summary", note), 0),
    selectedTokens: selectedSummaryTokens,
    targetTokens: summaryTarget,
    sourceCount: (summaryValue ? 1 : 0) + (input.pinnedNotes?.length ?? 0),
    selectedCount: (summary.text ? 1 : 0) + notes.selected.length,
    truncated: summary.truncated || notes.selected.length < (input.pinnedNotes?.length ?? 0),
    omitted: selectedSummaryTokens === 0,
  });

  const savedValue = input.savedMemoryPrompt ?? "";
  const referenceValue = input.referenceHistoryPrompt ?? "";
  let memoryRemaining = memoryTarget;
  const saved = fitText(estimator, savedValue, "saved_memory", memoryRemaining);
  memoryRemaining = Math.max(0, memoryRemaining - saved.tokens);
  const reference = fitText(estimator, referenceValue, "reference_history", memoryRemaining);
  addComponent(components, {
    name: "saved_memory",
    estimatedTokens: textEstimate(estimator, "saved_memory", savedValue),
    selectedTokens: saved.tokens,
    targetTokens: memoryTarget,
    sourceCount: savedValue ? 1 : 0,
    selectedCount: saved.text ? 1 : 0,
    truncated: saved.truncated,
    omitted: saved.tokens === 0,
  });
  addComponent(components, {
    name: "reference_history",
    estimatedTokens: textEstimate(estimator, "reference_history", referenceValue),
    selectedTokens: reference.tokens,
    targetTokens: memoryTarget,
    sourceCount: referenceValue ? 1 : 0,
    selectedCount: reference.text ? 1 : 0,
    truncated: reference.truncated,
    omitted: reference.tokens === 0,
  });

  const retrievalValue = input.targetedRetrievalPrompt ?? "";
  const retrieval = fitText(estimator, retrievalValue, "targeted_retrieval", retrievalTarget);
  addComponent(components, {
    name: "targeted_retrieval",
    estimatedTokens: textEstimate(estimator, "targeted_retrieval", retrievalValue),
    selectedTokens: retrieval.tokens,
    targetTokens: retrievalTarget,
    sourceCount: retrievalValue ? 1 : 0,
    selectedCount: retrieval.text ? 1 : 0,
    truncated: retrieval.truncated,
    omitted: retrieval.tokens === 0,
  });

  const currentId = input.currentUser.id;
  const checkpointIndex = input.continuityThroughMessageId
    ? input.messages.findIndex((message) => message.id === input.continuityThroughMessageId)
    : -1;
  const sourceMessages = checkpointIndex >= 0 ? input.messages.slice(checkpointIndex + 1) : input.messages;
  const previousMessages = sourceMessages.filter((message) => currentId ? message.id !== currentId : message !== input.currentUser);
  const units = groupConversationUnits(previousMessages, estimator);
  const selectedRecent = selectRecentUnits(units, recentTarget);
  let selectedRecentBudget = selectedRecent.used;
  const selectedUnitIds = new Set(selectedRecent.selected);
  let selectedUnits = units.filter((unit) => selectedUnitIds.has(unit.index));

  // If state slots are sparse, flow unused capacity to more recent complete
  // units, then targeted retrieval. The raw tail remains capped at ~20k.
  let usedStateTokens = selectedSummaryTokens + saved.tokens + reference.tokens + retrieval.tokens + selectedRecentBudget;
  let extra = Math.max(0, stateBudget - usedStateTokens);
  if (extra > 0 && selectedRecentBudget < RECENT_TAIL_TARGET) {
    for (let index = units.length - 1; index >= 0 && extra > 0; index -= 1) {
      const unit = units[index];
      if (!unit || selectedUnitIds.has(unit.index) || unit.tokens > extra || selectedRecentBudget + unit.tokens > RECENT_TAIL_TARGET) continue;
      selectedUnitIds.add(unit.index);
      selectedRecentBudget += unit.tokens;
      extra -= unit.tokens;
    }
    selectedUnits = units.filter((unit) => selectedUnitIds.has(unit.index));
    usedStateTokens = selectedSummaryTokens + saved.tokens + reference.tokens + retrieval.tokens + selectedRecentBudget;
  }
  if (extra > 0 && retrieval.text && retrieval.tokens < RETRIEVAL_TARGET) {
    const expanded = fitText(estimator, retrievalValue, "targeted_retrieval", Math.min(RETRIEVAL_TARGET, retrieval.tokens + extra));
    if (expanded.tokens > retrieval.tokens) {
      const entry = components.find((component) => component.name === "targeted_retrieval");
      if (entry) {
        entry.selectedTokens = expanded.tokens;
        entry.truncated = expanded.truncated;
        entry.selectedCount = expanded.text ? 1 : 0;
      }
    }
  }

  const selectedRawMessages = selectedUnits.flatMap((unit) => unit.messages);
  const messageLedger = [
    ...previousMessages.map((message) => ({ id: message.id ?? null, role: message.role, estimatedTokens: messageEstimate(estimator, message), selected: selectedRawMessages.includes(message) })),
    { id: currentId ?? null, role: input.currentUser.role, estimatedTokens: currentTokens, selected: true },
  ];
  addComponent(components, {
    name: "recent_raw_tail",
    estimatedTokens: previousMessages.reduce((sum, message) => sum + messageEstimate(estimator, message), 0),
    selectedTokens: selectedRecentBudget,
    targetTokens: recentTarget,
    sourceCount: previousMessages.length,
    selectedCount: selectedRawMessages.length,
    truncated: selectedRawMessages.length < previousMessages.length,
    omitted: selectedRawMessages.length === 0,
  });

  const selectedInputTokens = mandatoryTokens + selectedStateTokens(components);
  const projectedInputTokens = mandatoryTokens + components
    .filter((component) => component.name !== "system_time" && component.name !== "tool_schemas" && component.name !== "current_user")
    .reduce((sum, component) => sum + component.estimatedTokens, 0);
  const uncertaintyReserve = estimateUncertainty(selectedInputTokens, uncertaintyRate);
  const ledger: ContextTokenLedger = {
    version: "iris-context-ledger-v1",
    provider: input.provider,
    model: input.model,
    tokenizer: estimator.metadata,
    normalEnvelopeTokens: normalEnvelope,
    burstEnvelopeTokens: burstEnvelope,
    envelopeTokens: burstUsed ? burstEnvelope : normalEnvelope,
    outputReserveTokens: outputReserve,
    safetyReserveTokens: safetyReserve,
    uncertaintyRate,
    uncertaintyReserveTokens: uncertaintyReserve,
    inputBudgetTokens: inputBudget,
    projectedInputTokens,
    estimatedInputTokens: selectedInputTokens,
    estimatedTotalWithUncertaintyTokens: selectedInputTokens + uncertaintyReserve + outputReserve + safetyReserve,
    burstUsed,
    burstReason: burstUsed ? "current_turn_does_not_fit_normal" : "none",
    components,
    messages: messageLedger,
  };

  // The final current turn is always present in full and is placed last.
  const modelMessages = [...selectedRawMessages, input.currentUser].map((message) => ({
    ...(message.id ? { id: message.id } : {}),
    role: message.role,
    content: message.content,
    ...(message.isComplete !== undefined ? { isComplete: message.isComplete } : {}),
    ...(message.unitId ? { unitId: message.unitId } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolResultFor ? { toolResultFor: message.toolResultFor } : {}),
  }));
  return {
    messages: modelMessages,
    prompt: {
      threadSummary: summary.text || null,
      pinnedNotes: notes.selected,
      savedMemoryPrompt: saved.text,
      referenceHistoryPrompt: reference.text,
      targetedRetrievalPrompt: retrieval.text,
    },
    ledger,
  };
}

function selectedStateTokens(components: readonly ContextComponentLedger[]) {
  return components
    .filter((component) => component.name !== "system_time" && component.name !== "tool_schemas" && component.name !== "current_user")
    .reduce((sum, component) => sum + component.selectedTokens, 0);
}
