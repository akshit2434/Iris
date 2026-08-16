"use client";

import { FluidReveal } from "@/components/fluid-reveal";
import { ProfilePicker } from "@/components/profile-picker";
import { useProfile } from "@/components/profile-provider";

export function FilesScreen() {
  const { profileId, isReady } = useProfile();
  if (!isReady) return null;
  if (!profileId) return <div className="mx-auto flex min-h-[calc(100dvh-4rem)] max-w-4xl items-center px-5 py-12"><ProfilePicker /></div>;

  return <FluidReveal className="relative mx-auto min-h-[calc(100dvh-4rem)] w-full max-w-4xl px-5 pb-8 pt-12 sm:px-9 sm:pt-20">
    <div className="ambient-orb -right-56 -top-40" />
    <div className="relative mx-auto max-w-3xl">
      <h1 data-reveal className="text-[clamp(2.8rem,10vw,5.4rem)] font-medium leading-none tracking-[-.06em]">Files</h1>
      <div data-reveal className="mt-12 flex min-h-72 items-center justify-center rounded-[34px] border border-white/64 bg-white/30 px-6 text-center backdrop-blur-xl">
        <div><div className="mx-auto h-16 w-14 rounded-[18px] border border-white/90 bg-gradient-to-br from-white/90 to-[#e5edff]/70 shadow-[0_16px_30px_rgba(85,108,150,.12)]"><span className="mx-auto mt-4 block h-1 w-6 rounded-full bg-[#90a8e8]/45" /><span className="mx-auto mt-2 block h-1 w-8 rounded-full bg-[#90a8e8]/25" /></div><h2 className="mt-6 text-lg font-semibold tracking-tight">Nothing here yet.</h2></div>
      </div>
    </div>
  </FluidReveal>;
}
