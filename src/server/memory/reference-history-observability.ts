import type { ProfileId } from "@/lib/profiles";

export type ReferenceHistoryTelemetryScope = {
  profileId: ProfileId;
  jobId: string;
  threadId: string | null;
  sourceRunId: string | null;
};

/**
 * Resolve optional source links from the owned triggering run. A job remains
 * fully observable when its source run is absent, stale, or not owned by the
 * profile; in those cases both links are intentionally null.
 */
export async function resolveReferenceHistoryTelemetryScope(input: {
  profileId: ProfileId;
  jobId: string;
  sourceRunId: string | null;
  getRunScope: (profileId: ProfileId, runId: string) => Promise<{ threadId: string } | null>;
}): Promise<ReferenceHistoryTelemetryScope> {
  if (!input.sourceRunId) {
    return { profileId: input.profileId, jobId: input.jobId, threadId: null, sourceRunId: null };
  }
  const scope = await input.getRunScope(input.profileId, input.sourceRunId);
  if (!scope) {
    return { profileId: input.profileId, jobId: input.jobId, threadId: null, sourceRunId: null };
  }
  return { profileId: input.profileId, jobId: input.jobId, threadId: scope.threadId, sourceRunId: input.sourceRunId };
}
