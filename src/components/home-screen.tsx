"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Thread } from "@/lib/types";
import { FluidReveal } from "@/components/fluid-reveal";
import { HomeAttentionCard } from "@/components/home-attention-card";
import { IrisMark } from "@/components/iris-mark";
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
      if (!response.ok || !body.threads) throw new Error(body.error ?? "Could not load chats.");
      setThreads(body.threads);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load chats.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { if (profileId) void loadThreads(); }, [loadThreads, profileId]);

  function createChat() {
    setError(null);
    router.push("/chat/new");
  }

  if (!isReady) return null;

  if (!profileId) {
    return <FluidReveal className="relative mx-auto flex min-h-[calc(100dvh-4rem)] w-full max-w-4xl items-center px-5 py-12 sm:px-9">
      <div className="ambient-orb -right-36 top-10" />
      <div className="relative w-full">
        <div data-reveal className="mb-14 max-w-xl"><IrisMark size={58} priority /><h1 className="mt-7 text-[clamp(2.65rem,11vw,5.4rem)] font-medium leading-[.98] tracking-[-.055em] text-slate-950">Choose your space.</h1></div>
        <div data-reveal><ProfilePicker /></div>
      </div>
    </FluidReveal>;
  }

  return <FluidReveal className="relative mx-auto min-h-[calc(100dvh-4rem)] w-full max-w-5xl px-5 pb-8 pt-10 sm:px-9 sm:pt-16 lg:min-h-dvh lg:pt-20">
    <div className="ambient-orb -right-40 -top-20" />
    <section className="relative mx-auto max-w-3xl pt-3 sm:pt-7">
      <div data-reveal className="flex items-start justify-between gap-6">
        <h1 className="max-w-2xl text-[clamp(2.55rem,9.5vw,5.8rem)] font-medium leading-[.98] tracking-[-.06em] text-slate-950">What’s on your mind, {profileLabels[profileId]}?</h1>
        <IrisMark size={52} priority />
      </div>

      <HomeAttentionCard />

      <button data-reveal type="button" onClick={createChat} className="soft-press glass-surface group mt-10 flex min-h-20 w-full items-center gap-4 rounded-[28px] px-5 text-left sm:mt-14 sm:min-h-24 sm:px-7">
        <span className="flex-1 text-base font-medium text-slate-500 sm:text-lg">Start a conversation</span>
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[18px] bg-[#111827] text-white shadow-[0_10px_24px_rgba(17,24,39,.18)] transition group-hover:translate-x-0.5" aria-hidden="true">
          <span className="text-xl font-light">↗</span>
        </span>
      </button>

      <section data-reveal className="mt-14 sm:mt-20">
        <div className="mb-4 flex items-center justify-between px-1"><h2 className="text-[15px] font-semibold tracking-tight text-slate-900">Recent</h2>{isLoading ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-[#4978ed]" aria-label="Loading chats" /> : null}</div>
        {error ? <p className="mb-4 rounded-2xl bg-red-50/80 px-4 py-3 text-sm font-medium text-red-600">{error}</p> : null}
        <ThreadList threads={threads.slice(0, 5)} emptyMessage="No chats yet." />
        {threads.length > 5 ? <button type="button" onClick={() => router.push("/history")} className="mt-5 px-1 text-sm font-semibold text-[#4978ed]">All history</button> : null}
      </section>
    </section>
  </FluidReveal>;
}
