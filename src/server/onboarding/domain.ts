import type { ProfileId } from "@/lib/profiles";

export const ONBOARDING_STATES = ["not_started", "in_progress", "complete", "deferred"] as const;
export type OnboardingState = (typeof ONBOARDING_STATES)[number];
export const ACCOUNTABILITY_TONES = ["gentle", "balanced", "direct"] as const;
export type AccountabilityTone = (typeof ACCOUNTABILITY_TONES)[number];

export type OnboardingProfile = {
  profileId: ProfileId;
  state: OnboardingState;
  deferredAt: string | null;
  confirmedTimezone: string | null;
  accountabilityTone: AccountabilityTone | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type OnboardingSnapshot = OnboardingProfile & {
  savedMemoryCount: number;
  userMessageCount: number;
  eligible: boolean;
  questionPending: boolean;
};

export const MAX_COLD_START_USER_MESSAGES = 3;

export function isOnboardingEligible(input: {
  temporaryChat: boolean;
  state: OnboardingState;
  savedMemoryCount: number;
  userMessageCount: number;
}) {
  return !input.temporaryChat
    && input.state !== "complete"
    && input.state !== "deferred"
    && input.savedMemoryCount === 0
    && input.userMessageCount <= MAX_COLD_START_USER_MESSAGES;
}

export function createOnboardingSnapshot(input: {
  profile: OnboardingProfile;
  savedMemoryCount: number;
  userMessageCount: number;
  temporaryChat?: boolean;
}): OnboardingSnapshot {
  const eligible = isOnboardingEligible({
    temporaryChat: input.temporaryChat ?? false,
    state: input.profile.state,
    savedMemoryCount: input.savedMemoryCount,
    userMessageCount: input.userMessageCount,
  });
  return { ...input.profile, savedMemoryCount: input.savedMemoryCount, userMessageCount: input.userMessageCount, eligible, questionPending: eligible };
}
