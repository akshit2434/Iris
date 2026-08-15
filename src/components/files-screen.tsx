"use client";

import { FileText } from "lucide-react";
import { ProfilePicker } from "@/components/profile-picker";
import { useProfile } from "@/components/profile-provider";

export function FilesScreen() {
  const { profileId, isReady } = useProfile();
  if (!isReady) return <div className="mx-auto max-w-5xl animate-pulse p-5 sm:p-8"><div className="h-8 w-48 rounded-xl bg-white" /></div>;
  if (!profileId) return <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-5xl items-center px-5 py-12 sm:px-8"><ProfilePicker /></div>;

  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-8 sm:px-8 sm:py-12">
      <h1 className="text-3xl font-semibold tracking-tight text-slate-950">Files</h1>
      <div className="mt-8 flex min-h-72 flex-col items-center justify-center rounded-[32px] border border-dashed border-slate-200 bg-white/75 px-6 text-center shadow-[0_18px_60px_rgba(120,145,190,0.08)]">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--iris-accent-soft)] text-[var(--iris-accent)]"><FileText size={23} /></span>
        <h2 className="mt-5 text-lg font-semibold text-slate-900">Nothing here yet.</h2>
      </div>
    </div>
  );
}
