"use client";

import { FluidReveal } from "@/components/fluid-reveal";
import { ProfilePicker } from "@/components/profile-picker";
import { useProfile } from "@/components/profile-provider";
import Link from "next/link";

export function ProfileScreen() {
  const { profileId, profileLabels, isReady } = useProfile();

  if (!isReady) return null;
  if (!profileId) return <div className="mx-auto flex min-h-[calc(100dvh-4rem)] max-w-4xl items-center px-5 py-12"><ProfilePicker /></div>;

  return <FluidReveal className="relative mx-auto min-h-[calc(100dvh-4rem)] w-full max-w-4xl px-5 pb-8 pt-12 sm:px-9 sm:pt-20">
    <div className="ambient-orb -right-56 -top-40" />
    <div className="relative mx-auto max-w-3xl">
      <h1 data-reveal className="text-[clamp(2.8rem,10vw,5.4rem)] font-medium leading-none tracking-[-.06em]">Profile</h1>
      <section data-reveal className="glass-surface mt-10 rounded-[28px] p-5 sm:p-6" aria-labelledby="current-profile-heading">
        <p id="current-profile-heading" className="text-xs font-semibold uppercase tracking-[.14em] text-slate-400">Current space</p>
        <div className="mt-4 flex items-center gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[18px] bg-[#e7edff] text-base font-bold text-[#4978ed]">{profileLabels[profileId].slice(0, 1)}</span>
          <div><p className="font-semibold tracking-tight text-slate-900">{profileLabels[profileId]}</p><p className="mt-0.5 text-sm text-slate-500">Chats and files stay isolated to this space.</p></div>
        </div>
      </section>
      <section data-reveal className="mt-5 rounded-[26px] border border-white/70 bg-white/38 p-5 sm:p-6" aria-labelledby="memory-heading">
        <div className="flex items-center justify-between gap-4"><div><h2 id="memory-heading" className="font-semibold tracking-tight text-slate-900">Memory</h2><p className="mt-1 text-sm text-slate-500">Inspect the durable notes kept for this space.</p></div><Link href="/memory" className="soft-press rounded-xl bg-[#111827] px-3 py-2 text-xs font-semibold text-white">Open</Link></div>
      </section>
      <section data-reveal className="mt-12" aria-labelledby="switch-profile-heading">
        <h2 id="switch-profile-heading" className="text-lg font-semibold tracking-tight text-slate-900">Switch space</h2>
        <p className="mt-1 text-sm text-slate-500">Choose another private space for the next chat.</p>
        <div className="mt-5"><ProfilePicker /></div>
      </section>
    </div>
  </FluidReveal>;
}
