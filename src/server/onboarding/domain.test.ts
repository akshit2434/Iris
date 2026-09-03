import { describe, expect, it } from "vitest";
import { createOnboardingSnapshot, isOnboardingEligible } from "@/server/onboarding/domain";
import { buildDynamicSystemPrompt, createAgentContext } from "@/server/agent/context";

const profile = { profileId: "profile-a" as const, state: "not_started" as const, deferredAt: null, confirmedTimezone: null, accountabilityTone: null, createdAt: null, updatedAt: null };

describe("cold-start onboarding eligibility", () => {
  it("allows a persistent, memory-sparse profile with little authored history", () => {
    expect(isOnboardingEligible({ temporaryChat: false, state: "not_started", savedMemoryCount: 0, userMessageCount: 1 })).toBe(true);
    expect(createOnboardingSnapshot({ profile, savedMemoryCount: 0, userMessageCount: 1 }).questionPending).toBe(true);
  });

  it("excludes meaningful memory, completed/deferred state, long history, and temporary chats", () => {
    expect(isOnboardingEligible({ temporaryChat: false, state: "in_progress", savedMemoryCount: 1, userMessageCount: 1 })).toBe(false);
    expect(isOnboardingEligible({ temporaryChat: false, state: "complete", savedMemoryCount: 0, userMessageCount: 1 })).toBe(false);
    expect(isOnboardingEligible({ temporaryChat: false, state: "deferred", savedMemoryCount: 0, userMessageCount: 1 })).toBe(false);
    expect(isOnboardingEligible({ temporaryChat: false, state: "not_started", savedMemoryCount: 0, userMessageCount: 4 })).toBe(false);
    expect(isOnboardingEligible({ temporaryChat: true, state: "not_started", savedMemoryCount: 0, userMessageCount: 0 })).toBe(false);
  });

  it("gives the agent a one-question, concrete-request-first policy", () => {
    const prompt = buildDynamicSystemPrompt(createAgentContext({
      profileId: "profile-a",
      profileLabel: "Profile A",
      threadId: "00000000-0000-4000-8000-000000000001",
      threadTitle: "New chat",
      onboarding: { eligible: true, questionPending: true, state: "not_started", confirmedTimezone: null, accountabilityTone: null },
    }));
    expect(prompt).toContain("ask at most one warm");
    expect(prompt).toContain("answer it first");
    expect(prompt).toContain("memory_patch, not onboarding_update");
  });
});
