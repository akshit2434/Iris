"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowLeftRight,
  Archive,
  FileText,
  Home,
  Plus,
  Sparkles,
} from "lucide-react";
import { ProfileProvider, useProfile } from "@/components/profile-provider";

const navItems = [
  { href: "/", label: "Home", icon: Home },
  { href: "/history", label: "History", icon: Archive },
  { href: "/files", label: "Files", icon: FileText },
];

export function AppShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <ProfileProvider>
      <ShellContents>{children}</ShellContents>
    </ProfileProvider>
  );
}

function ShellContents({ children }: Readonly<{ children: ReactNode }>) {
  const pathname = usePathname();
  const router = useRouter();
  const { profileId, profileLabels, isReady, clearProfile } = useProfile();
  const [isCreating, setIsCreating] = useState(false);

  async function createNewChat() {
    if (!profileId) {
      router.push("/");
      return;
    }

    setIsCreating(true);
    try {
      const response = await fetch("/api/threads", { method: "POST" });
      const body = (await response.json()) as { thread?: { id: string }; error?: string };
      if (!response.ok || !body.thread) {
        throw new Error(body.error ?? "Could not create a chat.");
      }
      router.push(`/chat/${body.thread.id}`);
    } finally {
      setIsCreating(false);
    }
  }

  async function switchProfile() {
    await clearProfile();
    router.push("/");
  }

  return (
    <div className="min-h-screen bg-[var(--iris-background)]">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 flex-col border-r border-[var(--iris-border)] bg-white/75 px-4 py-5 backdrop-blur lg:flex">
        <Link href="/" className="flex items-center gap-3 px-3" aria-label="Iris home">
          <span className="flex h-10 w-10 items-center justify-center rounded-[17px] bg-slate-950 text-white shadow-sm">
            <Sparkles size={19} strokeWidth={2.2} />
          </span>
          <span className="text-[15px] font-bold tracking-tight text-slate-950">Iris</span>
        </Link>

        <button
          type="button"
          onClick={() => void createNewChat()}
          disabled={isCreating}
          className="mt-8 flex items-center justify-center gap-2 rounded-[18px] bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-slate-800 disabled:cursor-wait disabled:opacity-60"
        >
          <Plus size={17} />
          {isCreating ? "Starting…" : "New chat"}
        </button>

        <nav className="mt-7 space-y-1" aria-label="Primary navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                  active ? "bg-[var(--iris-accent-soft)] text-[var(--iris-accent)]" : "text-slate-500 hover:bg-slate-50 hover:text-slate-900"
                }`}
              >
                <Icon size={17} strokeWidth={active ? 2.2 : 1.8} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto flex items-center justify-between rounded-[20px] border border-slate-100 bg-white/70 p-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--iris-accent-soft)] text-sm font-bold text-[var(--iris-accent)]">
              {profileId ? profileLabels[profileId].slice(0, 1) : "·"}
            </span>
            <p className="truncate text-sm font-semibold text-slate-800">
              {profileId ? profileLabels[profileId] : isReady ? "Choose profile" : "Loading"}
            </p>
          </div>
          {profileId ? (
            <button
              type="button"
              onClick={() => void switchProfile()}
              aria-label="Switch profile"
              title="Switch profile"
              className="rounded-xl p-2 text-slate-400 transition hover:bg-[var(--iris-accent-soft)] hover:text-[var(--iris-accent)]"
            >
              <ArrowLeftRight size={16} />
            </button>
          ) : null}
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b border-[var(--iris-border)] bg-[var(--iris-background)]/80 px-5 backdrop-blur lg:hidden">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-950 text-white">
              <Sparkles size={16} />
            </span>
            <span className="font-bold tracking-tight text-slate-950">Iris</span>
          </Link>
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--iris-accent-soft)] text-xs font-bold text-[var(--iris-accent)]">
            {profileId ? profileLabels[profileId].slice(0, 1) : "·"}
          </span>
        </header>

        <main className="min-h-[calc(100vh-4rem)] pb-24 lg:min-h-screen lg:pb-8">{children}</main>

        <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-[var(--iris-border)] bg-white/95 px-2 py-2 backdrop-blur lg:hidden" aria-label="Mobile navigation">
          <Link href="/" className={`flex flex-1 flex-col items-center gap-1 rounded-xl py-1.5 text-[11px] font-semibold ${pathname === "/" ? "text-[var(--iris-accent)]" : "text-slate-400"}`}>
            <Home size={18} />
            Home
          </Link>
          <Link href="/history" className={`flex flex-1 flex-col items-center gap-1 rounded-xl py-1.5 text-[11px] font-semibold ${pathname.startsWith("/history") ? "text-[var(--iris-accent)]" : "text-slate-400"}`}>
            <Archive size={18} />
            History
          </Link>
          <button type="button" onClick={() => void createNewChat()} disabled={isCreating} className="flex flex-1 flex-col items-center gap-1 rounded-xl py-1.5 text-[11px] font-semibold text-slate-400 disabled:opacity-50">
            <span className="flex h-[18px] w-[18px] items-center justify-center rounded-md bg-slate-900 text-white"><Plus size={14} /></span>
            New chat
          </button>
          <Link href="/files" className={`flex flex-1 flex-col items-center gap-1 rounded-xl py-1.5 text-[11px] font-semibold ${pathname.startsWith("/files") ? "text-[var(--iris-accent)]" : "text-slate-400"}`}>
            <FileText size={18} />
            Files
          </Link>
        </nav>
      </div>
    </div>
  );
}
