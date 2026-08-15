"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_PROFILE_LABELS, PROFILE_STORAGE_KEY, isProfileId, type ProfileId } from "@/lib/profiles";

type ProfileContextValue = {
  profileId: ProfileId | null;
  profileLabels: Record<ProfileId, string>;
  isReady: boolean;
  error: string | null;
  selectProfile: (profileId: ProfileId) => Promise<void>;
  clearProfile: () => Promise<void>;
};

const ProfileContext = createContext<ProfileContextValue | null>(null);

async function syncProfile(profileId: ProfileId | null) {
  const response = await fetch("/api/profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileId }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Could not select that profile.");
  }
}

export function ProfileProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [profileId, setProfileId] = useState<ProfileId | null>(null);
  const [profileLabels, setProfileLabels] = useState(DEFAULT_PROFILE_LABELS);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem(PROFILE_STORAGE_KEY);
    if (!isProfileId(saved)) {
      setIsReady(true);
      return;
    }

    void syncProfile(saved)
      .then(() => setProfileId(saved))
      .catch((syncError: unknown) => {
        setError(syncError instanceof Error ? syncError.message : "Could not select that profile.");
      })
      .finally(() => setIsReady(true));
  }, []);

  useEffect(() => {
    void fetch("/api/profiles")
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { profiles?: Array<{ id: ProfileId; displayName: string }> };
        const profiles = body.profiles;
        if (!profiles) return;
        setProfileLabels((current) => ({
          ...current,
          ...Object.fromEntries(profiles.map((profile) => [profile.id, profile.displayName])),
        }));
      })
      .catch(() => undefined);
  }, []);

  const selectProfile = useCallback(async (nextProfileId: ProfileId) => {
    setError(null);
    await syncProfile(nextProfileId);
    window.localStorage.setItem(PROFILE_STORAGE_KEY, nextProfileId);
    setProfileId(nextProfileId);
  }, []);

  const clearProfile = useCallback(async () => {
    setError(null);
    await syncProfile(null);
    window.localStorage.removeItem(PROFILE_STORAGE_KEY);
    setProfileId(null);
  }, []);

  const value = useMemo(
    () => ({ profileId, profileLabels, isReady, error, selectProfile, clearProfile }),
    [clearProfile, error, isReady, profileId, profileLabels, selectProfile],
  );

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfile() {
  const context = useContext(ProfileContext);
  if (!context) {
    throw new Error("useProfile must be used inside ProfileProvider.");
  }
  return context;
}
