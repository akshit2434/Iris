"use client";

import { useState } from "react";
import { PROFILE_IDS, type ProfileId } from "@/lib/profiles";
import { useProfile } from "@/components/profile-provider";

export function ProfilePicker() {
  const { selectProfile, profileLabels, error: profileError } = useProfile();
  const [pending, setPending] = useState<ProfileId | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(profileId: ProfileId) {
    setPending(profileId);
    setError(null);
    try { await selectProfile(profileId); }
    catch (selectionError) { setError(selectionError instanceof Error ? selectionError.message : "Could not select that profile."); }
    finally { setPending(null); }
  }

  return <div className="w-full max-w-2xl">
    <div className="grid gap-3 sm:grid-cols-2">
      {PROFILE_IDS.map((profileId, index) => <button key={profileId} type="button" onClick={() => void choose(profileId)} disabled={pending !== null} className="soft-press glass-surface group flex min-h-28 items-center gap-4 rounded-[26px] p-4 text-left disabled:opacity-60 sm:min-h-36 sm:p-5">
        <span className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-[22px] text-base font-semibold ${index === 0 ? "bg-[#e7efff] text-[#416fd8]" : "bg-[#f0eaff] text-[#7256bd]"}`}>{profileLabels[profileId].slice(0, 1)}</span>
        <span className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight">{profileLabels[profileId]}</span>
        {pending === profileId ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-[#4978ed]" aria-label="Selecting profile" /> : <ChevronRightIcon />}
      </button>)}
    </div>
    {error || profileError ? <p className="mt-4 text-sm font-medium text-red-600">{error ?? profileError}</p> : null}
  </div>;
}

function ChevronRightIcon() {
  return <svg viewBox="0 0 20 20" className="mr-1 h-5 w-5 text-slate-300 transition-transform group-hover:translate-x-1 group-hover:text-slate-700 motion-reduce:transition-none" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" aria-hidden="true"><path d="m7.5 4.5 5.5 5.5-5.5 5.5" /></svg>;
}
