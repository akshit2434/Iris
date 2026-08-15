"use client";

import { useState } from "react";
import { ChevronRight, LoaderCircle } from "lucide-react";
import { PROFILE_IDS, type ProfileId } from "@/lib/profiles";
import { useProfile } from "@/components/profile-provider";

export function ProfilePicker() {
  const { selectProfile, profileLabels, error: profileError } = useProfile();
  const [pending, setPending] = useState<ProfileId | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(profileId: ProfileId) {
    setPending(profileId);
    setError(null);
    try {
      await selectProfile(profileId);
    } catch (selectionError) {
      setError(selectionError instanceof Error ? selectionError.message : "Could not select that profile.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="w-full max-w-2xl">
      <h2 className="mb-5 text-lg font-semibold text-slate-900">Choose a space</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {PROFILE_IDS.map((profileId) => (
          <button
            key={profileId}
            type="button"
            onClick={() => void choose(profileId)}
            disabled={pending !== null}
            className="group flex min-h-32 flex-col justify-between rounded-[28px] border border-white/80 bg-white/80 p-5 text-left shadow-[0_12px_40px_rgba(120,145,190,0.1)] transition hover:-translate-y-0.5 hover:border-[var(--iris-accent)] hover:bg-white disabled:cursor-wait disabled:opacity-70"
          >
            <span className="flex items-center justify-between">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-100 text-sm font-bold text-slate-600 group-hover:bg-[var(--iris-accent-soft)] group-hover:text-[var(--iris-accent)]">
                {profileLabels[profileId].slice(0, 1)}
              </span>
              {pending === profileId ? <LoaderCircle size={18} className="animate-spin text-[var(--iris-accent)]" /> : <ChevronRight size={18} className="text-slate-300 transition group-hover:translate-x-1 group-hover:text-[var(--iris-accent)]" />}
            </span>
            <span>
              <span className="block text-lg font-semibold text-slate-900">{profileLabels[profileId]}</span>
            </span>
          </button>
        ))}
      </div>
      {error || profileError ? <p className="mt-4 text-sm font-medium text-red-600">{error ?? profileError}</p> : null}
    </div>
  );
}
