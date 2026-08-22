import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AttentionSnapshotPayload } from "@/lib/checkin-actions";
import { buildHomeAttentionView } from "@/lib/home-attention";

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
          { loopId: "loop-b", title: "Buy groceries", kind: "commitment", status: "open", dueAt: null, responded: false },
          { loopId: "loop-c", title: "Call plumber", kind: "commitment", status: "open", dueAt: null, responded: false },
          { loopId: "loop-d", title: "Weekly review", kind: "routine", status: "open", dueAt: null, responded: true },
        ],
      },
      {
        deliveryId: "delivery-2",
        threadId: "thread-1",
        messageId: "message-2",
        summary: null,
        createdAt: "2026-08-22T09:00:00.000Z",
        items: [{ loopId: "loop-e", title: "Water plants", kind: "commitment", status: "open", dueAt: null, responded: false }],
      },
    ],
    counts: { openLoops: 5, overdueCommitments: 2 },
    topOverdue: [],
    ...overrides,
  };
}

describe("home attention view model", () => {
  it("shows at most three unanswered questions and counts the rest plus overdue commitments", () => {
    const view = buildHomeAttentionView(snapshot());
    expect(view).toEqual({
      questions: [
        { key: "delivery-1:loop-a", deliveryId: "delivery-1", loopId: "loop-a", title: "Renew passport", informational: false },
        { key: "delivery-1:loop-b", deliveryId: "delivery-1", loopId: "loop-b", title: "Buy groceries", informational: false },
        { key: "delivery-1:loop-c", deliveryId: "delivery-1", loopId: "loop-c", title: "Call plumber", informational: false },
      ],
      extraCount: 1,
      overdueCount: 2,
    });
  });

  it("returns null when nothing needs attention", () => {
    expect(
      buildHomeAttentionView(snapshot({ pendingDeliveries: [], counts: { openLoops: 3, overdueCommitments: 0 }, topOverdue: [] })),
    ).toBeNull();
  });

  it("still surfaces the overdue count when every question is answered", () => {
    const onlyOverdue = snapshot({
      pendingDeliveries: [],
      counts: { openLoops: 2, overdueCommitments: 3 },
      topOverdue: [{ loopId: "loop-f", title: "Tax filing", dueAt: "2026-08-20T09:00:00.000Z", daysOverdue: 4 }],
    });
    expect(buildHomeAttentionView(onlyOverdue)).toEqual({ questions: [], extraCount: 0, overdueCount: 3 });
  });
});

describe("accountability surfaces mount points", () => {
  it("mounts the home attention card above the chat entry button on Home", () => {
    const source = readFileSync(new URL("../components/home-screen.tsx", import.meta.url), "utf8");
    expect(source).toContain("<HomeAttentionCard />");
    expect(source.indexOf("<HomeAttentionCard />")).toBeLessThan(source.indexOf("Start a conversation"));
  });

  it("renders inline check-in quick actions that answer through the respond endpoint in chat", () => {
    const chatSource = readFileSync(new URL("../components/chat-screen.tsx", import.meta.url), "utf8");
    expect(chatSource).toContain("/api/accountability/respond");
    expect(chatSource).toContain('"/api/accountability/attention"');
    expect(chatSource).toContain("CHECKIN_QUICK_ACTIONS");
    const cardSource = readFileSync(new URL("../components/home-attention-card.tsx", import.meta.url), "utf8");
    expect(cardSource).toContain("/api/accountability/attention");
    expect(cardSource).toContain("/api/accountability/respond");
    expect(cardSource).toContain("buildHomeAttentionView");
    expect(cardSource).toContain("CHECKIN_QUICK_ACTIONS");
    const libSource = readFileSync(new URL("./checkin-actions.ts", import.meta.url), "utf8");
    for (const label of ["Done", "Not today", "Drop it"]) {
      expect(libSource).toContain(`"${label}"`);
    }
  });

  it("renders informational briefing questions without quick-action buttons on both surfaces", () => {
    const cardSource = readFileSync(new URL("../components/home-attention-card.tsx", import.meta.url), "utf8");
    const chatSource = readFileSync(new URL("../components/chat-screen.tsx", import.meta.url), "utf8");
    for (const source of [cardSource, chatSource]) {
      expect(source).toContain("question.informational ?");
    }
  });
});
