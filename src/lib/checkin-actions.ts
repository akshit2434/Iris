export type CheckinOutcome = "done" | "later" | "drop";

export const CHECKIN_QUICK_ACTIONS: ReadonlyArray<{ outcome: CheckinOutcome; label: string }> = [
  { outcome: "done", label: "Done" },
  { outcome: "later", label: "Not today" },
  { outcome: "drop", label: "Drop it" },
];

const PREFILL_TEXTS: Record<CheckinOutcome, (title: string) => string> = {
  done: (title) => `Done — ${title}`,
  later: (title) => `Not today — ${title} will stay open`,
  drop: (title) => `Please drop ${title} from my follow-ups`,
};

export function buildPrefill(outcome: CheckinOutcome, item: { title: string }): string {
  return PREFILL_TEXTS[outcome](item.title);
}

export function buildAttentionHref(): string {
  return "/chat/new";
}

export type AttentionItemPayload = {
  loopId: string;
  title: string;
  kind: "commitment" | "routine" | "idea";
  status: string;
  dueAt: string | null;
  responded: boolean;
};

export type AttentionDeliveryPayload = {
  deliveryId: string;
  threadId: string;
  messageId: string | null;
  summary: string | null;
  createdAt: string;
  items: AttentionItemPayload[];
};

export type AttentionSnapshotPayload = {
  pendingDeliveries: AttentionDeliveryPayload[];
  counts: { openLoops: number; overdueCommitments: number };
  topOverdue: Array<{ loopId: string; title: string; dueAt: string; daysOverdue: number }>;
};

export type PendingQuestion = { key: string; deliveryId: string; loopId: string; title: string };

function questionKey(deliveryId: string, loopId: string): string {
  return `${deliveryId}:${loopId}`;
}

export function flattenPendingQuestions(snapshot: AttentionSnapshotPayload): PendingQuestion[] {
  return snapshot.pendingDeliveries.flatMap((delivery) =>
    delivery.items
      .filter((item) => !item.responded)
      .map((item) => ({ key: questionKey(delivery.deliveryId, item.loopId), deliveryId: delivery.deliveryId, loopId: item.loopId, title: item.title })),
  );
}

export function pendingQuestionsByMessageId(snapshot: AttentionSnapshotPayload): Map<string, PendingQuestion[]> {
  const byMessageId = new Map<string, PendingQuestion[]>();
  for (const delivery of snapshot.pendingDeliveries) {
    if (!delivery.messageId) continue;
    const questions = flattenPendingQuestions({ ...snapshot, pendingDeliveries: [delivery] });
    if (questions.length > 0) byMessageId.set(delivery.messageId, questions);
  }
  return byMessageId;
}
