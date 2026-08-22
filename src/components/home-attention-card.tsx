"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  CHECKIN_QUICK_ACTIONS,
  buildAttentionHref,
  type AttentionSnapshotPayload,
  type CheckinOutcome,
  type PendingQuestion,
} from "@/lib/checkin-actions";
import { buildHomeAttentionView } from "@/lib/home-attention";

function actionButtonClass(outcome: CheckinOutcome): string {
  return outcome === "done"
    ? "bg-[#111827] text-white shadow-[0_8px_18px_rgba(17,24,39,.16)]"
    : "bg-white/65 text-slate-600 shadow-[inset_0_0_0_1px_rgba(255,255,255,.78)]";
}

export function HomeAttentionCard() {
  const [snapshot, setSnapshot] = useState<AttentionSnapshotPayload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [respondingKey, setRespondingKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadSnapshot = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetch("/api/accountability/attention", { cache: "no-store" });
      const body = (await response.json()) as Partial<AttentionSnapshotPayload> & { error?: string };
      if (!response.ok || !body.pendingDeliveries || !body.counts) throw new Error(body.error ?? "Could not load follow-ups.");
      setActionError(null);
      setSnapshot(body as AttentionSnapshotPayload);
    } catch {
      setSnapshot(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void loadSnapshot(); }, [loadSnapshot]);

  async function respond(question: PendingQuestion, outcome: CheckinOutcome) {
    if (respondingKey) return;
    setRespondingKey(question.key);
    setActionError(null);
    try {
      const response = await fetch("/api/accountability/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deliveryId: question.deliveryId, loopId: question.loopId, outcome }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Could not save that answer.");
      }
      await loadSnapshot();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not save that answer.");
    } finally {
      setRespondingKey(null);
    }
  }

  const view = snapshot ? buildHomeAttentionView(snapshot) : null;
  if (isLoading && !snapshot) {
    return (
      <div className="glass-surface mt-8 animate-pulse space-y-3 rounded-[28px] p-5" aria-hidden="true">
        <div className="h-3 w-24 rounded-full bg-slate-200/80" />
        <div className="h-4 w-3/5 rounded-full bg-slate-200/70" />
        <div className="h-11 w-full rounded-[16px] bg-white/55" />
      </div>
    );
  }
  if (!view) return null;

  return (
    <section aria-label="Follow-ups awaiting you" className="glass-surface mt-8 rounded-[28px] p-4 sm:p-5">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">Follow-ups</h2>
        {isLoading ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-[#4978ed]" aria-label="Updating follow-ups" /> : null}
      </div>
      <ul className="mt-3 space-y-2.5">
        {view.questions.map((question) => (
          <li key={question.key} className="rounded-[20px] bg-white/45 p-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,.72)]">
            <p className="truncate text-sm font-medium text-slate-800">{question.title}</p>
            <div className="mt-2 flex gap-2">
              {CHECKIN_QUICK_ACTIONS.map(({ outcome, label }) => (
                <button
                  key={outcome}
                  type="button"
                  disabled={respondingKey !== null}
                  onClick={() => void respond(question, outcome)}
                  className={`soft-press min-h-11 flex-1 rounded-[14px] px-2 text-xs font-semibold transition disabled:opacity-40 ${actionButtonClass(outcome)}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {actionError ? <p className="mt-3 px-1 text-xs font-medium text-red-600">{actionError}</p> : null}
      {view.extraCount > 0 ? (
        <Link href={buildAttentionHref()} className="mt-3 inline-flex min-h-11 items-center px-1 text-sm font-semibold text-[#4978ed]">
          +{view.extraCount} more
        </Link>
      ) : null}
      {view.overdueCount > 0 ? (
        <p className={`text-xs font-medium text-amber-600 ${view.extraCount > 0 ? "mt-1 px-1" : "mt-3 px-1"}`}>
          {view.overdueCount} commitment{view.overdueCount === 1 ? "" : "s"} overdue
        </p>
      ) : null}
    </section>
  );
}
