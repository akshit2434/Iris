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
import { buildHomeAttentionView, type HomeAttentionView } from "@/lib/home-attention";

const ATTENTION_CARD_SURFACE = "glass-surface rounded-[28px] p-4 sm:p-5";
const ATTENTION_CARD_TRANSITION = "transition-[opacity,filter,transform] duration-500 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none";
const ATTENTION_CARD_COLLAPSE = "transition-[max-height,opacity,margin] duration-500 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none";

function actionButtonClass(outcome: CheckinOutcome): string {
  return outcome === "done"
    ? "bg-[#111827] text-white shadow-[0_8px_18px_rgba(17,24,39,.16)]"
    : "bg-white/65 text-slate-600 shadow-[inset_0_0_0_1px_rgba(255,255,255,.78)]";
}

function CheckinActionIcon({ outcome }: Readonly<{ outcome: CheckinOutcome }>) {
  if (outcome === "done") return <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" aria-hidden="true"><path d="m3.3 8.2 2.9 2.9 6.5-6.5" /></svg>;
  if (outcome === "later") return <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.35" aria-hidden="true"><circle cx="8" cy="8" r="5.3" /><path d="M8 4.8v3.5l2.3 1.4" /></svg>;
  return <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.35" aria-hidden="true"><path d="M3.5 5h9M6.3 5V3.5h3.4V5m-5 0 .6 7.5h5.4l.6-7.5M6.8 7.2v3.2m2.4-3.2v3.2" /></svg>;
}

export function HomeAttentionCard() {
  const [snapshot, setSnapshot] = useState<AttentionSnapshotPayload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [contentVisible, setContentVisible] = useState(false);
  const [isPresent, setIsPresent] = useState(true);
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
      if (body.pendingDeliveries.length > 0) window.localStorage.setItem("iris-followups-experienced", "true");
    } catch {
      setSnapshot(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void loadSnapshot(); }, [loadSnapshot]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void loadSnapshot();
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [loadSnapshot]);

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
      const body = (await response.json().catch(() => null)) as { error?: string; warning?: string } | null;
      if (!response.ok) {
        throw new Error(body?.error ?? "Could not save that answer.");
      }
      if (body?.warning) setActionError(body.warning);
      await loadSnapshot();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not save that answer.");
    } finally {
      setRespondingKey(null);
    }
  }

  const view = snapshot ? buildHomeAttentionView(snapshot) : null;
  const hasView = view !== null;
  const viewKey = view ? `${view.questions.map((question) => `${question.key}:${question.informational}`).join("|")}:${view.extraCount}:${view.overdueCount}` : null;

  useEffect(() => {
    if (isLoading || hasView) {
      setIsPresent(true);
      return;
    }
    const timeout = window.setTimeout(() => setIsPresent(false), 500);
    return () => window.clearTimeout(timeout);
  }, [hasView, isLoading, viewKey]);

  useEffect(() => {
    if (!hasView || isLoading) return;
    const frame = window.requestAnimationFrame(() => setContentVisible(true));
    return () => window.cancelAnimationFrame(frame);
  }, [hasView, isLoading, viewKey]);

  if (!isPresent) return null;

  const leaving = !isLoading && !view;
  const showSkeleton = !contentVisible || (isLoading && !snapshot);

  return (
    <div className={`relative overflow-hidden ${ATTENTION_CARD_COLLAPSE} ${leaving ? "mt-0 max-h-0 opacity-0" : "mt-8 max-h-[520px]"}`} aria-busy={isLoading || undefined}>
      <AttentionCardSkeleton view={view} visible={showSkeleton && !leaving} positioned={Boolean(view && contentVisible)} />
      {view ? (
        <section
          aria-label="Follow-ups awaiting you"
          aria-hidden={!contentVisible || undefined}
          className={`${contentVisible ? "relative" : "absolute inset-x-0 top-0"} ${ATTENTION_CARD_SURFACE} ${ATTENTION_CARD_TRANSITION} ${contentVisible ? "opacity-100 blur-0 scale-100" : "pointer-events-none scale-[.99] opacity-0 blur-[4px]"}`}
        >
          <div className="flex items-center justify-between px-1">
            <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">Follow-ups</h2>
            {isLoading ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-[#4978ed]" aria-label="Updating follow-ups" /> : null}
          </div>
          <ul className="mt-3 space-y-2.5">
            {view.questions.map((question) => (
              <li key={question.key} className="rounded-[20px] bg-white/45 p-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,.72)]">
                <p className="truncate text-sm font-medium text-slate-800">{question.title}</p>
                {question.informational ? (
                  <p className="mt-1 text-xs font-medium text-slate-500">No response needed</p>
                ) : (
                  <div className="mt-2 flex gap-2">
                    {CHECKIN_QUICK_ACTIONS.map(({ outcome, label }) => (
                      <button
                        key={outcome}
                        type="button"
                        disabled={respondingKey !== null}
                        onClick={() => void respond(question, outcome)}
                        className={`soft-press flex h-10 w-10 items-center justify-center rounded-[14px] transition disabled:opacity-40 ${actionButtonClass(outcome)}`}
                        aria-label={label}
                        title={label}
                      >
                        <CheckinActionIcon outcome={outcome} />
                      </button>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {actionError ? <p className="mt-3 px-1 text-xs font-medium text-red-600">{actionError}</p> : null}
          {view.extraCount > 0 ? (
            <Link href={buildAttentionHref(snapshot ?? undefined)} className="mt-3 inline-flex min-h-11 items-center px-1 text-sm font-semibold text-[#4978ed]">
              +{view.extraCount} more
            </Link>
          ) : null}
          {view.overdueCount > 0 ? (
            <p className={`text-xs font-medium text-amber-600 ${view.extraCount > 0 ? "mt-1 px-1" : "mt-3 px-1"}`}>
              {view.overdueCount} commitment{view.overdueCount === 1 ? "" : "s"} overdue
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function AttentionCardSkeleton({ view, visible, positioned }: Readonly<{ view: HomeAttentionView | null; visible: boolean; positioned: boolean }>) {
  const questions = view?.questions ?? [{ informational: false }];
  return (
    <div aria-hidden="true" className={`${positioned ? "absolute inset-x-0 top-0" : "relative"} ${ATTENTION_CARD_SURFACE} ${ATTENTION_CARD_TRANSITION} ${visible ? "opacity-100 blur-0 scale-100" : "pointer-events-none scale-[1.01] opacity-0 blur-[2px]"}`}>
      <div className="flex items-center justify-between px-1">
        <span className="h-5 w-24 rounded-full bg-slate-200/70" />
        <span className="h-4 w-4 rounded-full bg-slate-200/55" />
      </div>
      <div className="mt-3 space-y-2.5">
        {questions.map((question, index) => (
          <div key={index} className="rounded-[20px] bg-white/45 p-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,.72)]">
            <span className="block h-5 w-3/5 rounded-full bg-slate-200/70" />
            {question.informational ? <span className="mt-1 block h-4 w-28 rounded-full bg-slate-200/55" /> : (
              <div className="mt-2 flex gap-2">
                {CHECKIN_QUICK_ACTIONS.map(({ outcome }) => <span key={outcome} className="h-10 w-10 rounded-[14px] bg-white/65" />)}
              </div>
            )}
          </div>
        ))}
      </div>
      {view?.extraCount ? <span className="mt-3 block h-11 w-24 rounded-xl bg-slate-200/55" /> : null}
      {view?.overdueCount ? <span className={`block h-4 w-40 rounded-full bg-amber-100/80 ${view.extraCount ? "mt-1" : "mt-3"}`} /> : null}
    </div>
  );
}
