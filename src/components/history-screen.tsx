"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { LoaderCircle, Search } from "lucide-react";
import type { Thread } from "@/lib/types";
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
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/threads", { cache: "no-store" });
      const body = (await response.json()) as { threads?: Thread[]; error?: string };
      if (!response.ok || !body.threads) throw new Error(body.error ?? "Could not load history.");
      setThreads(body.threads);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load history.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (profileId) void loadThreads();
  }, [loadThreads, profileId]);

  const filteredThreads = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized ? threads.filter((thread) => thread.title.toLowerCase().includes(normalized)) : threads;
  }, [query, threads]);

  if (!isReady) return <div className="mx-auto max-w-5xl animate-pulse p-5 sm:p-8"><div className="h-8 w-48 rounded-xl bg-white" /></div>;
  if (!profileId) return <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-5xl items-center px-5 py-12 sm:px-8"><ProfilePicker /></div>;

  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-8 sm:px-8 sm:py-12">
      <div className="flex items-center justify-between gap-4"><h1 className="text-3xl font-semibold tracking-tight text-slate-950">History</h1>{loading ? <LoaderCircle className="animate-spin text-slate-300" size={19} /> : null}</div>
      <div className="relative mt-7"><Search size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search chat titles" className="w-full rounded-[20px] border border-white/80 bg-white/80 py-3.5 pl-11 pr-4 text-sm text-slate-900 shadow-[0_10px_32px_rgba(120,145,190,0.08)] outline-none transition placeholder:text-slate-400 focus:border-[var(--iris-accent)] focus:bg-white" /></div>
      {error ? <p className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm font-medium text-red-600">{error}</p> : null}
      <div className="mt-6"><ThreadList threads={filteredThreads} emptyMessage={query ? "No matches." : "No chats yet."} /></div>
    </div>
  );
}
