"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, LoaderCircle, Plus, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import type { Thread } from "@/lib/types";
import { ProfilePicker } from "@/components/profile-picker";
import { ThreadList } from "@/components/thread-list";
import { useProfile } from "@/components/profile-provider";

export function HomeScreen() {
  const router = useRouter();
  const { profileId, profileLabels, isReady } = useProfile();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadThreads = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/threads", { cache: "no-store" });
      const body = (await response.json()) as { threads?: Thread[]; error?: string };
      if (!response.ok || !body.threads) {
        throw new Error(body.error ?? "Could not load chats.");
      }
      setThreads(body.threads);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load chats.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (profileId) {
      void loadThreads();
    }
  }, [loadThreads, profileId]);

  async function createChat() {
    setError(null);
    try {
      const response = await fetch("/api/threads", { method: "POST" });
      const body = (await response.json()) as { thread?: Thread; error?: string };
      if (!response.ok || !body.thread) {
        throw new Error(body.error ?? "Could not create a chat.");
      }
      router.push(`/chat/${body.thread.id}`);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Could not create a chat.");
    }
  }

  if (!isReady) {
    return <div className="mx-auto w-full max-w-5xl animate-pulse p-5 sm:p-8"><div className="h-8 w-52 rounded-xl bg-white" /><div className="mt-6 h-40 rounded-3xl bg-white" /></div>;
  }

  if (!profileId) {
    return (
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-5xl items-center px-5 py-12 sm:px-8">
        <div className="w-full">
          <div className="mb-10 max-w-xl">
            <h1 className="text-4xl font-semibold tracking-tight text-slate-950 sm:text-6xl">A quieter place to think.</h1>
          </div>
          <ProfilePicker />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-8 sm:px-8 sm:py-12">
      <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">What matters now, {profileLabels[profileId]}?</h1>
        </div>
        <button type="button" onClick={() => void createChat()} className="inline-flex w-fit items-center gap-2 rounded-[18px] bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-slate-800"><Plus size={17} /> New chat</button>
      </div>

      <section className="mt-10 rounded-[32px] border border-white/80 bg-gradient-to-br from-[#dff1ff] via-[#edf0ff] to-white p-6 shadow-[0_18px_60px_rgba(120,145,190,0.12)] sm:p-9">
        <div className="flex items-start justify-between gap-5">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">Start a new thought.</h2>
          </div>
          <span className="hidden rounded-2xl bg-white/70 p-3 text-[var(--iris-accent)] sm:block"><Sparkles size={19} /></span>
        </div>
        <button type="button" onClick={() => void createChat()} className="mt-6 inline-flex items-center gap-2 text-sm font-bold text-[var(--iris-accent)] hover:underline">New chat <ArrowUpRight size={16} /></button>
      </section>

      <section className="mt-10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold text-slate-900">Recent chats</h2>
          {isLoading ? <LoaderCircle size={18} className="animate-spin text-slate-300" /> : null}
        </div>
        {error ? <p className="mb-4 rounded-2xl bg-red-50 px-4 py-3 text-sm font-medium text-red-600">{error}</p> : null}
        <ThreadList threads={threads.slice(0, 6)} emptyMessage="No chats yet." />
        {threads.length > 6 ? <button type="button" onClick={() => router.push("/history")} className="mt-4 text-sm font-semibold text-[var(--iris-accent)] hover:underline">View all history</button> : null}
      </section>
    </div>
  );
}
