import { describe, expect, it, vi } from "vitest";
import { resolveReferenceHistoryTelemetryScope } from "@/server/memory/reference-history-observability";

const runId = "00000000-0000-0000-0000-000000000010";
const threadId = "00000000-0000-0000-0000-000000000011";

describe("reference-history telemetry scope", () => {
  it("uses the triggering run's thread, not the first source message thread", async () => {
    const getRunScope = vi.fn(async () => ({ threadId }));
    await expect(resolveReferenceHistoryTelemetryScope({ profileId: "profile-a", jobId: "00000000-0000-0000-0000-000000000012", sourceRunId: runId, getRunScope })).resolves.toEqual({
      profileId: "profile-a",
      jobId: "00000000-0000-0000-0000-000000000012",
      threadId,
      sourceRunId: runId,
    });
    expect(getRunScope).toHaveBeenCalledWith("profile-a", runId);
  });

  it("keeps job telemetry when there is no source run or no owned run match", async () => {
    const getRunScope = vi.fn(async () => null);
    await expect(resolveReferenceHistoryTelemetryScope({ profileId: "profile-a", jobId: "00000000-0000-0000-0000-000000000013", sourceRunId: runId, getRunScope })).resolves.toMatchObject({ threadId: null, sourceRunId: null });
    await expect(resolveReferenceHistoryTelemetryScope({ profileId: "profile-a", jobId: "00000000-0000-0000-0000-000000000014", sourceRunId: null, getRunScope })).resolves.toMatchObject({ threadId: null, sourceRunId: null });
    expect(getRunScope).toHaveBeenCalledTimes(1);
  });

  it("does not attach a foreign profile run", async () => {
    const getRunScope = vi.fn(async (profileId: "profile-a" | "profile-b") => profileId === "profile-a" ? { threadId } : null);
    await expect(resolveReferenceHistoryTelemetryScope({ profileId: "profile-b", jobId: "00000000-0000-0000-0000-000000000015", sourceRunId: runId, getRunScope })).resolves.toMatchObject({ profileId: "profile-b", threadId: null, sourceRunId: null });
    expect(getRunScope).toHaveBeenCalledWith("profile-b", runId);
  });
});
