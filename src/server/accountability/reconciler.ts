import "server-only";

import { ChatOpenRouter } from "@langchain/openrouter";
import type { ProfileId } from "@/lib/profiles";
import { getConfiguredModelName } from "@/server/agent";
import { createProductionMemoryRetrievalService } from "@/server/memory/retrieval";
import type { OpenLoopRow } from "./repository";
import { SOFT_CLOSE_EXCERPT_MAX_CHARS, truncateAtWordBoundary } from "./composer";

export const RECONCILIATION_CANDIDATE_LIMIT = 3;
export const SOFT_CLOSE_CONFIDENCE_THRESHOLD = 0.7;
const RECONCILIATION_OVERDUE_MS = 2 * 86_400_000;

export type ReconciliationCandidate = {
  messageId: string;
  threadId: string;
  content: string;
  createdAt: string;
};

export type CommitmentSearchClient = (input: {
  profileId: ProfileId;
  query: string;
  from?: string | null;
  limit: number;
}) => Promise<ReconciliationCandidate[]>;

export type CompletionClassification = { completed: boolean; confidence: number };

export type CompletionClassifier = (input: {
  title: string;
  candidates: ReconciliationCandidate[];
}) => Promise<CompletionClassification>;

export type SoftClosePlan = {
  loopId: string;
  excerpt: string;
  confidence: number;
};

type ReconcilableLoop = Pick<OpenLoopRow, "id" | "title" | "kind" | "status" | "dueAt" | "createdAt">;

/** The soft-close backstop only considers open one-off commitments overdue beyond the catch-up window. */
export function isReconciliationEligible(loop: Pick<OpenLoopRow, "kind" | "status" | "dueAt">, nowIso: string): boolean {
  if (loop.status !== "open" || loop.kind !== "commitment" || loop.dueAt === null) return false;
  const dueMs = Date.parse(loop.dueAt);
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(dueMs) || Number.isNaN(nowMs)) return false;
  return nowMs - dueMs > RECONCILIATION_OVERDUE_MS;
}

/** Evidence is quoted back to the user, so it stays short, single-line, and word-bounded. */
export function excerptForSoftClose(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (compact.length <= SOFT_CLOSE_EXCERPT_MAX_CHARS) return compact;
  return `${truncateAtWordBoundary(compact, SOFT_CLOSE_EXCERPT_MAX_CHARS - 1)}…`;
}

/**
 * Detects completions the user already stated in passing so a nudge can become
 * a confirm-close instead of nagging. Every failure degrades to "not
 * completed": reconciliation is a backstop and must never block delivery.
 */
export async function reconcileOverdueCommitments(input: {
  profileId: ProfileId;
  loops: ReconcilableLoop[];
  now: string;
  retrieval: CommitmentSearchClient;
  classifier: CompletionClassifier;
}): Promise<Map<string, SoftClosePlan>> {
  const plans = new Map<string, SoftClosePlan>();
  for (const loop of input.loops) {
    if (!isReconciliationEligible(loop, input.now)) continue;
    try {
      const candidates = await input.retrieval({
        profileId: input.profileId,
        query: loop.title,
        from: loop.createdAt,
        limit: RECONCILIATION_CANDIDATE_LIMIT,
      });
      if (candidates.length === 0) continue;
      const classification = await input.classifier({ title: loop.title, candidates });
      if (!classification.completed || classification.confidence < SOFT_CLOSE_CONFIDENCE_THRESHOLD) continue;
      plans.set(loop.id, {
        loopId: loop.id,
        excerpt: excerptForSoftClose(candidates[0]?.content ?? ""),
        confidence: classification.confidence,
      });
    } catch {
      continue;
    }
  }
  return plans;
}

/** Wraps the production hybrid message search; completion statements come from the user. */
export function createProductionCommitmentRetrieval(): CommitmentSearchClient {
  const service = createProductionMemoryRetrievalService();
  return async ({ profileId, query, from, limit }) => {
    const results = await service.searchMessages({ profileId, query, roles: ["user"], from: from ?? null, limit });
    return results.map((result) => ({
      messageId: result.messageId,
      threadId: result.threadId,
      content: result.content,
      createdAt: result.createdAt,
    }));
  };
}

/** The small-model completion classifier; mirrors the title generator's cost profile. */
export function createProductionCompletionClassifier(): CompletionClassifier {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required.");

  const model = new ChatOpenRouter({
    apiKey,
    model: process.env.OPENROUTER_TITLE_MODEL ?? getConfiguredModelName(),
    temperature: 0,
    maxTokens: 24,
    stop: ["\n"],
    modelKwargs: { reasoning: { effort: "none" } },
  });

  return async ({ title, candidates }) => {
    const transcript = candidates
      .map((candidate) => `- (${candidate.createdAt}) ${candidate.content.replace(/\s+/g, " ").slice(0, 300)}`)
      .join("\n");
    const response = await model.invoke([
      {
        role: "system",
        content:
          'You decide whether chat history shows the user already finished a specific commitment. Reply with strict minified JSON only: {"completed":boolean,"confidence":number} where confidence is between 0 and 1. Mentioning the task without finishing it counts as not completed.',
      },
      {
        role: "user",
        content: `Commitment: ${title}\nRecent messages:\n${transcript}`,
      },
    ]);
    const text = typeof response.content === "string" ? response.content : String(response.content ?? "");
    return parseClassification(text);
  };
}

function parseClassification(text: string): CompletionClassification {
  try {
    const parsed = JSON.parse(text.trim()) as { completed?: unknown; confidence?: unknown };
    if (typeof parsed.completed !== "boolean") return { completed: false, confidence: 0 };
    const confidence = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.min(Math.max(parsed.confidence, 0), 1)
      : parsed.completed
        ? SOFT_CLOSE_CONFIDENCE_THRESHOLD
        : 0;
    return { completed: parsed.completed, confidence };
  } catch {
    return { completed: false, confidence: 0 };
  }
}
