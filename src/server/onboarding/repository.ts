import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProfileId } from "@/lib/profiles";
import { getDatabase } from "@/server/db/client";
import type { Database } from "@/server/db/types";
import { createOnboardingSnapshot, type AccountabilityTone, type OnboardingProfile, type OnboardingSnapshot, type OnboardingState } from "./domain";

type OnboardingDatabase = SupabaseClient<Database>;
type OnboardingRow = Database["public"]["Tables"]["onboarding_profiles"]["Row"];

function toProfile(profileId: ProfileId, row: OnboardingRow | null): OnboardingProfile {
  return row ? {
    profileId: row.profile_id,
    state: row.state,
    deferredAt: row.deferred_at,
    confirmedTimezone: row.confirmed_timezone,
    accountabilityTone: row.accountability_tone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } : { profileId, state: "not_started", deferredAt: null, confirmedTimezone: null, accountabilityTone: null, createdAt: null, updatedAt: null };
}

export type OnboardingRepository = {
  loadSnapshot(profileId: ProfileId, options?: { temporaryChat?: boolean }): Promise<OnboardingSnapshot>;
  update(profileId: ProfileId, patch: { state?: OnboardingState; confirmedTimezone?: string | null; accountabilityTone?: AccountabilityTone | null }): Promise<OnboardingProfile>;
};

export function createOnboardingRepository(database: OnboardingDatabase = getDatabase()): OnboardingRepository {
  return {
    async loadSnapshot(profileId, options = {}) {
      const [profileResult, memoryResult, messagesResult] = await Promise.all([
        database.from("onboarding_profiles").select("profile_id, state, deferred_at, confirmed_timezone, accountability_tone, created_at, updated_at").eq("profile_id", profileId).maybeSingle(),
        database.from("memory_items").select("id", { count: "exact", head: true }).eq("profile_id", profileId).eq("status", "active"),
        database.from("messages").select("id", { count: "exact", head: true }).eq("profile_id", profileId).eq("role", "user"),
      ]);
      if (profileResult.error) throw profileResult.error;
      if (memoryResult.error) throw memoryResult.error;
      if (messagesResult.error) throw messagesResult.error;
      return createOnboardingSnapshot({
        profile: toProfile(profileId, profileResult.data),
        savedMemoryCount: memoryResult.count ?? 0,
        userMessageCount: messagesResult.count ?? 0,
        temporaryChat: options.temporaryChat,
      });
    },
    async update(profileId, patch) {
      const state = patch.state;
      const row = {
        profile_id: profileId,
        ...(state ? { state, deferred_at: state === "deferred" ? new Date().toISOString() : null } : {}),
        ...(patch.confirmedTimezone !== undefined ? { confirmed_timezone: patch.confirmedTimezone } : {}),
        ...(patch.accountabilityTone !== undefined ? { accountability_tone: patch.accountabilityTone } : {}),
        updated_at: new Date().toISOString(),
      };
      const { data, error } = await database.from("onboarding_profiles").upsert(row).select("profile_id, state, deferred_at, confirmed_timezone, accountability_tone, created_at, updated_at").single();
      if (error) throw error;
      return toProfile(profileId, data);
    },
  };
}
