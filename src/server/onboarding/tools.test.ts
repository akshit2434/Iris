import { describe, expect, it, vi } from "vitest";
import { updateOnboarding } from "@/server/agent/tools";
import type { AgentContext } from "@/server/agent/context";
import type { OnboardingRepository } from "@/server/onboarding/repository";
import type { OnboardingProfile } from "@/server/onboarding/domain";

const context = { profileId: "profile-a" } as AgentContext;
const repository = {
  loadSnapshot: vi.fn(),
  update: vi.fn(async (_profileId, patch): Promise<OnboardingProfile> => ({ profileId: "profile-a", state: patch.state ?? "not_started", deferredAt: patch.state === "deferred" ? "2026-09-03T00:00:00.000Z" : null, confirmedTimezone: patch.confirmedTimezone ?? null, accountabilityTone: patch.accountabilityTone ?? null, createdAt: null, updatedAt: null })),
} satisfies OnboardingRepository;

describe("onboarding_update", () => {
  it("records only scoped progress and consented preferences", async () => {
    const result = await updateOnboarding(context, { state: "deferred", confirmedTimezone: "Asia/Kolkata", accountabilityTone: "direct" }, repository);
    expect(result).toMatchObject({ kind: "onboarding_update", status: "updated", state: "deferred", confirmedTimezone: "Asia/Kolkata", accountabilityTone: "direct" });
    expect(repository.update).toHaveBeenCalledWith("profile-a", { state: "deferred", confirmedTimezone: "Asia/Kolkata", accountabilityTone: "direct" });
  });

  it("rejects non-IANA timezone input without mutating state", async () => {
    const before = repository.update.mock.calls.length;
    const result = await updateOnboarding(context, { confirmedTimezone: "tomorrow morning" }, repository);
    expect(result.status).toBe("invalid_timezone");
    expect(repository.update).toHaveBeenCalledTimes(before);
  });
});
