import { describe, expect, it } from "vitest";
import {
  CHECKIN_QUICK_ACTIONS,
  buildAttentionHref,
  buildPrefill,
  pendingQuestionsByMessageId,
  type AttentionSnapshotPayload,
} from "@/lib/checkin-actions";

function snapshot(overrides: Partial<AttentionSnapshotPayload> = {}): AttentionSnapshotPayload {
  return {
    pendingDeliveries: [
      {
        deliveryId: "delivery-1",
        threadId: "thread-1",
        messageId: "message-1",
        summary: null,
        createdAt: "2026-08-22T08:00:00.000Z",
        items: [
          { loopId: "loop-a", title: "Renew passport", kind: "commitment", status: "open", dueAt: null, responded: false },
          { loopId: "loop-b", title: "Buy groceries", kind: "commitment", status: "open", dueAt: null, responded: true },
        ],
      },
      {
        deliveryId: "delivery-2",
        threadId: "thread-1",
        messageId: null,
        summary: null,
        createdAt: "2026-08-22T09:00:00.000Z",
        items: [{ loopId: "loop-c", title: "Call plumber", kind: "commitment", status: "open", dueAt: null, responded: false }],
      },
      {
        deliveryId: "delivery-3",
        threadId: "thread-2",
        messageId: "message-2",
        summary: null,
        createdAt: "2026-08-22T10:00:00.000Z",
        items: [{ loopId: "loop-d", title: "Weekly review", kind: "routine", status: "open", dueAt: null, responded: false }],
      },
    ],
    counts: { openLoops: 4, overdueCommitments: 1 },
    topOverdue: [{ loopId: "loop-e", title: "Tax filing", dueAt: "2026-08-20T09:00:00.000Z", daysOverdue: 2 }],
    ...overrides,
  };
}

describe("check-in quick-action helpers", () => {
  it("prefills new-chat composer text for each outcome", () => {
    expect(buildPrefill("done", { title: "Renew passport" })).toBe("Done — Renew passport");
    expect(buildPrefill("later", { title: "Renew passport" })).toBe("Not today — Renew passport will stay open");
    expect(buildPrefill("drop", { title: "Renew passport" })).toBe("Please drop Renew passport from my follow-ups");
  });

  it("deep-links quick actions into a fresh chat", () => {
    expect(buildAttentionHref()).toBe("/chat/new");
  });

  it("offers exactly the three outcomes with stable button labels", () => {
    expect(CHECKIN_QUICK_ACTIONS).toEqual([
      { outcome: "done", label: "Done" },
      { outcome: "later", label: "Not today" },
      { outcome: "drop", label: "Drop it" },
    ]);
  });

  it("indexes unanswered check-in questions by delivered message id", () => {
    const byMessageId = pendingQuestionsByMessageId(snapshot());
    expect([...byMessageId.keys()]).toEqual(["message-1", "message-2"]);
    expect(byMessageId.get("message-1")).toEqual([
      { key: "delivery-1:loop-a", deliveryId: "delivery-1", loopId: "loop-a", title: "Renew passport" },
    ]);
    expect(byMessageId.get("message-2")).toEqual([
      { key: "delivery-3:loop-d", deliveryId: "delivery-3", loopId: "loop-d", title: "Weekly review" },
    ]);
  });

  it("returns an empty map when nothing is awaiting an answer", () => {
    const empty = snapshot({ pendingDeliveries: [] });
    expect(pendingQuestionsByMessageId(empty).size).toBe(0);
  });
});
