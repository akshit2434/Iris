"use client";

import Link from "next/link";
import type { Thread } from "@/lib/types";

function formatThreadDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value));
}

export function ThreadList({ threads, emptyMessage = "No chats yet." }: Readonly<{ threads: Thread[]; emptyMessage?: string }>) {
  if (threads.length === 0) return <div className="rounded-[26px] border border-white/60 bg-white/28 px-6 py-10 text-center text-sm text-slate-400 backdrop-blur-sm">{emptyMessage}</div>;

  return <div className="overflow-hidden rounded-[28px] border border-white/64 bg-white/42 shadow-[0_18px_50px_rgba(86,110,154,.08)] backdrop-blur-xl">
    {threads.map((thread, index) => <Link key={thread.id} href={`/chat/${thread.id}`} className={`group flex min-h-[72px] items-center gap-4 px-5 transition hover:bg-white/58 sm:px-6 ${index > 0 ? "border-t border-white/60" : ""}`}>
      <span className="h-8 w-1 shrink-0 rounded-full bg-gradient-to-b from-[#72c7ff] to-[#9d8fff] opacity-70" />
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold tracking-tight text-slate-800">{thread.title}</span><span className="mt-1 block text-xs text-slate-400">{formatThreadDate(thread.updatedAt)}</span></span>
      <span className="text-lg font-light text-slate-300 transition group-hover:translate-x-1 group-hover:text-slate-700" aria-hidden="true">→</span>
    </Link>)}
  </div>;
}
