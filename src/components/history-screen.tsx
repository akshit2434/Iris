"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Thread } from "@/lib/types";
import { FluidReveal } from "@/components/fluid-reveal";
import { ThreadList } from "@/components/thread-list";
import { useProfile } from "@/components/profile-provider";
import { ProfilePicker } from "@/components/profile-picker";

export function HistoryScreen() {
  const { profileId, isReady } = useProfile();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [skeletonRows, setSkeletonRows] = useState(4);
  const [error, setError] = useState<string | null>(null);

  const loadThreads = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const response = await fetch("/api/threads", { cache: "no-store" });
      const body = (await response.json()) as { threads?: Thread[]; error?: string };
      if (!response.ok || !body.threads) throw new Error(body.error ?? "Could not load history.");
      setSkeletonRows(body.threads.length);
      setThreads(body.threads);
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : "Could not load history."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (profileId) void loadThreads(); }, [loadThreads, profileId]);
  const filteredThreads = useMemo(() => { const value = query.trim().toLowerCase(); return value ? threads.filter((thread) => thread.title.toLowerCase().includes(value)) : threads; }, [query, threads]);
  const displayedSkeletonRows = loading ? skeletonRows : filteredThreads.length;

  if (!isReady) return null;
  if (!profileId) return <div className="mx-auto flex min-h-[calc(100dvh-4rem)] max-w-4xl items-center px-5 py-12"><ProfilePicker /></div>;

  return <FluidReveal className="relative mx-auto min-h-[calc(100dvh-4rem)] w-full max-w-4xl px-5 pb-8 pt-12 sm:px-9 sm:pt-20">
    <div className="ambient-orb -right-56 -top-40" />
    <div className="relative mx-auto max-w-3xl">
      <div data-reveal className="flex items-center justify-between"><h1 className="text-[clamp(2.8rem,10vw,5.4rem)] font-medium leading-none tracking-[-.06em]">History</h1></div>
      <div data-reveal className="mt-10"><label htmlFor="history-search" className="sr-only">Search chat titles</label><input id="history-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" className="glass-surface h-14 w-full rounded-[22px] px-5 text-sm text-slate-900 placeholder:text-slate-400 focus:bg-white/78" /></div>
      {error ? <p className="mt-4 rounded-2xl bg-red-50/80 px-4 py-3 text-sm font-medium text-red-600">{error}</p> : null}
      <div data-reveal className="history-results-transition mt-5" data-state={loading ? "loading" : "ready"} aria-busy={loading}>
        <div className={`history-results-layer history-results-layer--skeleton ${loading ? "history-results-layer--visible" : "history-results-layer--hidden"}`} aria-hidden={!loading} role={loading ? "status" : undefined} aria-label={loading ? "Loading history" : undefined}>
          <HistoryListSkeleton rowCount={displayedSkeletonRows} />
        </div>
        <div data-history-list="content" className={`history-results-layer history-results-layer--content ${loading ? "history-results-layer--hidden" : "history-results-layer--visible"} ${filteredThreads.length === 0 ? "history-list-content--empty" : ""}`} aria-hidden={loading || undefined}>
          <ThreadList threads={filteredThreads} emptyMessage={query ? "No matches." : "No chats yet."} />
        </div>
      </div>
    </div>
  </FluidReveal>;
}

function HistoryListSkeleton({ rowCount }: Readonly<{ rowCount: number }>) {
  if (rowCount === 0) {
    return <div className="history-list-skeleton history-list-skeleton--empty rounded-[26px] border border-white/60 bg-white/28 px-6 py-10 text-center backdrop-blur-sm"><span data-history-skeleton-bar className="mx-auto block h-3 w-24 rounded-full bg-white/65" /></div>;
  }

  return <div className="history-list-skeleton overflow-hidden rounded-[28px] border border-white/64 bg-white/42 shadow-[0_18px_50px_rgba(86,110,154,.08)] backdrop-blur-xl">
    {Array.from({ length: rowCount }, (_, index) => <div key={index} className={`flex min-h-[72px] items-center gap-4 px-5 sm:px-6 ${index > 0 ? "border-t border-white/60" : ""}`}>
      <span className="h-8 w-1 shrink-0 rounded-full bg-gradient-to-b from-[#72c7ff] to-[#9d8fff] opacity-35" />
      <span className="min-w-0 flex-1"><span data-history-skeleton-bar className="block h-3.5 w-[min(62%,16rem)] rounded-full bg-white/72" /><span data-history-skeleton-bar className="mt-2 block h-2.5 w-20 rounded-full bg-white/48" /></span>
      <span data-history-skeleton-bar className="h-4 w-4 shrink-0 rounded-full bg-white/52" />
    </div>)}
  </div>;
}
