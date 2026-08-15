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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadThreads = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const response = await fetch("/api/threads", { cache: "no-store" });
      const body = (await response.json()) as { threads?: Thread[]; error?: string };
      if (!response.ok || !body.threads) throw new Error(body.error ?? "Could not load history.");
      setThreads(body.threads);
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : "Could not load history."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (profileId) void loadThreads(); }, [loadThreads, profileId]);
  const filteredThreads = useMemo(() => { const value = query.trim().toLowerCase(); return value ? threads.filter((thread) => thread.title.toLowerCase().includes(value)) : threads; }, [query, threads]);

  if (!isReady) return <div className="mx-auto max-w-3xl animate-pulse px-5 pt-14"><div className="h-12 w-48 rounded-2xl bg-white/55" /></div>;
  if (!profileId) return <div className="mx-auto flex min-h-[calc(100dvh-4rem)] max-w-4xl items-center px-5 py-12"><ProfilePicker /></div>;

  return <FluidReveal className="relative mx-auto min-h-[calc(100dvh-4rem)] w-full max-w-4xl overflow-hidden px-5 pb-8 pt-12 sm:px-9 sm:pt-20">
    <div className="ambient-orb -right-56 -top-40" />
    <div className="relative mx-auto max-w-3xl">
      <div data-reveal className="flex items-center justify-between"><h1 className="text-[clamp(2.8rem,10vw,5.4rem)] font-medium leading-none tracking-[-.06em]">History</h1>{loading ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-[#4978ed]" aria-label="Loading history" /> : null}</div>
      <div data-reveal className="mt-10"><label htmlFor="history-search" className="sr-only">Search chat titles</label><input id="history-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" className="glass-surface h-14 w-full rounded-[22px] px-5 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:bg-white/78" /></div>
      {error ? <p className="mt-4 rounded-2xl bg-red-50/80 px-4 py-3 text-sm font-medium text-red-600">{error}</p> : null}
      <div data-reveal className="mt-5"><ThreadList threads={filteredThreads} emptyMessage={query ? "No matches." : "No chats yet."} /></div>
    </div>
  </FluidReveal>;
}
