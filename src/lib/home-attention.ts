import { flattenPendingQuestions, type AttentionSnapshotPayload, type PendingQuestion } from "@/lib/checkin-actions";

export const HOME_ATTENTION_MAX_QUESTIONS = 3;

export type HomeAttentionView = {
  questions: PendingQuestion[];
  extraCount: number;
  overdueCount: number;
};

export function buildHomeAttentionView(
  snapshot: AttentionSnapshotPayload,
  maxQuestions: number = HOME_ATTENTION_MAX_QUESTIONS,
): HomeAttentionView | null {
  const pendingQuestions = flattenPendingQuestions(snapshot);
  const overdueCount = snapshot.counts.overdueCommitments;
  if (pendingQuestions.length === 0 && overdueCount === 0) return null;
  return {
    questions: pendingQuestions.slice(0, maxQuestions),
    extraCount: Math.max(0, pendingQuestions.length - maxQuestions),
    overdueCount,
  };
}
