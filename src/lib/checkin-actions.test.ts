import { describe, expect, it } from "vitest";
import {
  CHECKIN_QUICK_ACTIONS,
  buildAttentionHref,
  pendingQuestionsByMessageId,
  type AttentionSnapshotPayload,
} from "@/lib/checkin-actions";
import { BRIEFING_LOOP_TITLE } from "@/lib/briefing";

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
  it("deep-links overflow questions into the newest pending delivery's thread", () => {
    expect(buildAttentionHref(snapshot())).toBe("/chat/thread-2");
    const olderFirst = snapshot({
      pendingDeliveries: [...snapshot().pendingDeliveries].reverse(),
    });
    expect(buildAttentionHref(olderFirst)).toBe("/chat/thread-2");
    expect(buildAttentionHref()).toBe("/chat/new");
    expect(buildAttentionHref({ pendingDeliveries: [] })).toBe("/chat/new");
    const allAnswered = snapshot({
      pendingDeliveries: snapshot().pendingDeliveries.map((delivery) => ({
        ...delivery,
        items: delivery.items.map((item) => ({ ...item, responded: true })),
      })),
    });
    expect(buildAttentionHref(allAnswered)).toBe("/chat/new");
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
      { key: "delivery-1:loop-a", deliveryId: "delivery-1", loopId: "loop-a", title: "Renew passport", informational: false },
    ]);
    expect(byMessageId.get("message-2")).toEqual([
      { key: "delivery-3:loop-d", deliveryId: "delivery-3", loopId: "loop-d", title: "Weekly review", informational: false },
    ]);
  });

  it("marks briefing items informational from the server flag or the reserved title", () => {
    const flagged = snapshot({
      pendingDeliveries: [
        {
          deliveryId: "delivery-briefing",
          threadId: "thread-9",
          messageId: "message-9",
          summary: "Morning briefing",
          createdAt: "2026-08-22T08:05:00.000Z",
          items: [{ loopId: "loop-briefing", title: BRIEFING_LOOP_TITLE, kind: "routine", status: "open", dueAt: null, responded: false, informational: true }],
        },
      ],
    });
    expect(pendingQuestionsByMessageId(flagged).get("message-9")).toEqual([
      { key: "delivery-briefing:loop-briefing", deliveryId: "delivery-briefing", loopId: "loop-briefing", title: BRIEFING_LOOP_TITLE, informational: true },
    ]);
    const titleOnly = snapshot({
      pendingDeliveries: [
        {
          deliveryId: "delivery-stale",
          threadId: "thread-8",
          messageId: "message-8",
          summary: null,
          createdAt: "2026-08-22T08:05:00.000Z",
          items: [{ loopId: "loop-briefing-old", title: BRIEFING_LOOP_TITLE, kind: "routine", status: "open", dueAt: null, responded: false }],
        },
      ],
    });
    expect(pendingQuestionsByMessageId(titleOnly).get("message-8")).toEqual([
      { key: "delivery-stale:loop-briefing-old", deliveryId: "delivery-stale", loopId: "loop-briefing-old", title: BRIEFING_LOOP_TITLE, informational: true },
    ]);
  });

  it("returns an empty map when nothing is awaiting an answer", () => {
    const empty = snapshot({ pendingDeliveries: [] });
    expect(pendingQuestionsByMessageId(empty).size).toBe(0);
  });
});
