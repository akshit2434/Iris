"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AssistantMarkdown } from "@/components/assistant-markdown";
import { FluidReveal } from "@/components/fluid-reveal";
import { ProfilePicker } from "@/components/profile-picker";
import { useProfile } from "@/components/profile-provider";
import { buildOpenMessageHref } from "@/lib/memory-source";

type MemorySummary = {
  canonicalKey: string;
  itemRevision: number;
  category: string;
  updatedAt: string;
  status: string;
  excerpt: string;
};

type MemoryDetail = {
  canonicalKey: string;
  content: string;
  itemRevision: number;
  category: string;
  status: string;
  updatedAt: string;
  revisions: Array<{
    itemRevision: number;
    profileGlobalRevision: number;
    mutationKind: string;
    createdAt: string;
    content: string;
    sources: Array<{
      sourceKind: string;
      sourceThreadId: string | null;
      sourceMessageId: string | null;
      sourceAgentEventId: string | null;
      sourceAgentRunId: string | null;
      sourceExcerpt: string | null;
      metadata: Record<string, unknown>;
      createdAt: string;
      action?: { type: "open_message"; threadId: string; messageId: string; label: string };
    }>;
  }>;
};

function formatDate(value: string) {
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); } catch { return value; }
}

export function MemoryScreen() {
  const { profileId, isReady } = useProfile();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [globalRevision, setGlobalRevision] = useState(0);
  const [items, setItems] = useState<MemorySummary[]>([]);
  const [details, setDetails] = useState<Record<string, MemoryDetail>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMemoryItems = useCallback(async (archived: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/memory${archived ? "?archived=true" : ""}`, { cache: "no-store" });
      const body = (await response.json()) as { globalRevision?: number; items?: MemorySummary[]; error?: string };
      if (!response.ok || !body.items) throw new Error(body.error ?? "Could not load memory.");
      setGlobalRevision(body.globalRevision ?? 0);
      setItems(body.items);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load memory.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (profileId) void loadMemoryItems(includeArchived); }, [includeArchived, loadMemoryItems, profileId]);

  async function toggleItem(canonicalKey: string) {
    if (expanded === canonicalKey) { setExpanded(null); return; }
    setExpanded(canonicalKey);
    if (details[canonicalKey]) return;
    try {
      const response = await fetch(`/api/memory?canonicalKey=${encodeURIComponent(canonicalKey)}${includeArchived ? "&archived=true" : ""}`, { cache: "no-store" });
      const body = (await response.json()) as { item?: MemoryDetail; error?: string };
      if (!response.ok || !body.item) throw new Error(body.error ?? "Could not load this memory.");
      setDetails((current) => ({ ...current, [canonicalKey]: body.item! }));
    } catch (detailError) {
      setError(detailError instanceof Error ? detailError.message : "Could not load this memory.");
    }
  }

  if (!isReady) return null;
  if (!profileId) return <div className="mx-auto flex min-h-[calc(100dvh-4rem)] max-w-4xl items-center px-5 py-12"><ProfilePicker /></div>;

  return <FluidReveal className="relative mx-auto min-h-[calc(100dvh-4rem)] w-full max-w-5xl px-5 pb-10 pt-12 sm:px-9 sm:pt-20">
    <div className="ambient-orb -right-56 -top-40" />
    <div className="relative mx-auto max-w-4xl">
      <div data-reveal className="flex flex-wrap items-end justify-between gap-5">
        <div><p className="text-sm font-medium text-slate-500">A quiet record of what Iris has been asked to retain.</p><h1 className="mt-2 text-[clamp(2.8rem,10vw,5.4rem)] font-medium leading-none tracking-[-.06em]">Memory</h1></div>
        <div className="text-right text-xs font-medium text-slate-400"><p>Profile-scoped</p><p className="mt-1">Revision {globalRevision}</p></div>
      </div>
      <div data-reveal className="mt-10 flex items-center justify-between gap-4">
        <p className="text-sm text-slate-500">Saved memory items stay editable only through a governed chat request.</p>
        <label className="flex shrink-0 items-center gap-2 text-xs font-semibold text-slate-600"><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} /> Show archived</label>
      </div>
      {error ? <p className="mt-4 rounded-2xl bg-red-50/80 px-4 py-3 text-sm font-medium text-red-600" role="alert">{error}</p> : null}
      <section data-reveal className="mt-6 space-y-3" aria-label="Saved memory items" aria-busy={loading}>
        {items.length === 0 && !loading ? <div className="glass-surface rounded-[28px] p-7 text-sm text-slate-500">{includeArchived ? "No archived memory items." : "No saved memory yet."}</div> : null}
        {items.map((item) => {
          const detail = details[item.canonicalKey];
          const isExpanded = expanded === item.canonicalKey;
          return <article key={item.canonicalKey} className={`glass-surface overflow-hidden rounded-[26px] transition-shadow ${isExpanded ? "shadow-[0_22px_60px_rgba(81,104,151,.16)]" : ""}`}>
            <button type="button" onClick={() => void toggleItem(item.canonicalKey)} aria-expanded={isExpanded} className="flex w-full items-start justify-between gap-4 p-5 text-left sm:p-6">
              <span className="min-w-0"><span className="block truncate font-semibold tracking-tight text-slate-900">{item.canonicalKey}</span><span className="mt-1 block text-sm leading-6 text-slate-500">{item.excerpt}</span></span>
              <span className="flex shrink-0 items-center gap-2 text-xs font-medium text-slate-400">r{item.itemRevision}<svg viewBox="0 0 16 16" className={`h-4 w-4 transition-transform motion-reduce:transition-none ${isExpanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></span>
            </button>
            {isExpanded ? <div className="border-t border-white/70 px-5 pb-6 pt-5 sm:px-6">{detail ? <MemoryDetailView detail={detail} /> : <p className="text-sm text-slate-400">Loading item…</p>}</div> : null}
          </article>;
        })}
      </section>
    </div>
  </FluidReveal>;
}

function MemoryDetailView({ detail }: Readonly<{ detail: MemoryDetail }>) {
  return <div>
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400"><span>{detail.status} · updated {formatDate(detail.updatedAt)}</span><span>{detail.revisions.length} revision{detail.revisions.length === 1 ? "" : "s"}</span></div>
    <div className="mt-5 text-[15px] text-slate-700"><AssistantMarkdown content={detail.content} live={false} terminal /></div>
    <div className="mt-8 space-y-3"><h2 className="text-xs font-semibold uppercase tracking-[.14em] text-slate-400">Provenance</h2>{detail.revisions.map((revision) => <div key={`${detail.canonicalKey}-${revision.itemRevision}`} className="rounded-2xl bg-white/42 px-4 py-3"><div className="flex flex-wrap justify-between gap-2 text-xs font-medium text-slate-500"><span>Revision {revision.itemRevision} · {revision.mutationKind}</span><span>{formatDate(revision.createdAt)}</span></div>{revision.sources.map((source, index) => <div key={`${revision.itemRevision}-${source.createdAt}-${index}`} className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600"><span>{source.sourceExcerpt || `Source: ${source.sourceKind}`}</span>{source.action ? <Link className="font-semibold text-[#416fd8]" href={buildOpenMessageHref(source.action) ?? "#"}>{source.action.label}</Link> : null}</div>)}</div>)}</div>
  </div>;
}
