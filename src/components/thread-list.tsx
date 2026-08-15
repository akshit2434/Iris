"use client";

import Link from "next/link";
import { ChevronRight, MessageCircle } from "lucide-react";
import type { Thread } from "@/lib/types";

function formatThreadDate(value: string) {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

export function ThreadList({ threads, emptyMessage = "No chats yet." }: Readonly<{ threads: Thread[]; emptyMessage?: string }>) {
  if (threads.length === 0) {
    return (
      <div className="rounded-[28px] border border-dashed border-slate-200 bg-white/55 px-6 py-12 text-center">
        <MessageCircle className="mx-auto text-slate-300" size={25} />
        <p className="mt-3 text-sm text-slate-500">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-slate-100 rounded-[28px] border border-white/80 bg-white/75 shadow-[0_14px_44px_rgba(120,145,190,0.08)]">
      {threads.map((thread) => (
        <Link key={thread.id} href={`/chat/${thread.id}`} className="group flex items-center gap-4 px-5 py-4 transition hover:bg-white sm:px-6">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[var(--iris-accent-soft)] text-[var(--iris-accent)]"><MessageCircle size={17} /></span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-slate-800">{thread.title}</span>
            <span className="mt-1 block text-xs text-slate-400">{formatThreadDate(thread.updatedAt)}</span>
          </span>
          <ChevronRight size={18} className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-[var(--iris-accent)]" />
        </Link>
      ))}
    </div>
  );
}
