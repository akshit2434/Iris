import { NextResponse } from "next/server";
import { createProductionConsolidationWorker } from "@/server/memory/consolidation";
import { createProductionThreadContinuityWorker } from "@/server/memory/compaction";
import { createProductionReferenceHistoryWorker } from "@/server/memory/reference-history";
import { hasWorkerSecret as compareWorkerSecret } from "@/server/memory/worker-auth";
import { appendReferenceHistoryAgentEvent, getAgentRunScope, getNextReferenceHistoryEventSequence } from "@/server/db/queries";
import { createAgentTraceRecorder } from "@/server/agent/observability";
import { resolveReferenceHistoryTelemetryScope } from "@/server/memory/reference-history-observability";

export const runtime = "nodejs";

export function hasWorkerSecret(request: Request) {
  const supplied = request.headers.get("x-iris-worker-secret") ?? "";
  return compareWorkerSecret(supplied);
}

export async function POST(request: Request) {
  if (!hasWorkerSecret(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as { limit?: unknown };
    const limit = typeof body.limit === "number" && Number.isInteger(body.limit) ? Math.min(Math.max(body.limit, 1), 3) : 1;
    const workerId = `http-${crypto.randomUUID()}`;
    const consolidation = process.env.MEMORY_CONSOLIDATION_ENABLED === "true"
      ? await createProductionConsolidationWorker({ limit, maxDurationMs: 25_000, workerId })
      : { claimed: 0, completed: 0, skipped: 0, failed: 0, conflicts: 0, indexingErrors: 0 };
    const continuity = process.env.MEMORY_CONTINUITY_ENABLED === "true"
      ? await createProductionThreadContinuityWorker({ limit, maxDurationMs: 25_000, workerId })
      : { claimed: 0, completed: 0, conflicts: 0, skipped: 0, failed: 0, invalidated: 0 };
    const referenceHistory = process.env.MEMORY_REFERENCE_HISTORY_ENABLED === "true"
      ? await createProductionReferenceHistoryWorker({
          limit,
          maxDurationMs: 25_000,
          workerId,
          observabilityFactory: async ({ job }) => {
            // A profile-wide job may synthesize messages from many threads.
            // Resolve the triggering run's own scope instead of trusting the
            // first source message, and keep telemetry job-scoped when no
            // owned source run can be resolved.
            const scope = await resolveReferenceHistoryTelemetryScope({
              profileId: job.profileId,
              jobId: job.id,
              sourceRunId: job.sourceRunId,
              getRunScope: getAgentRunScope,
            });
            let sequence = await getNextReferenceHistoryEventSequence(job.profileId, job.id);
            return createAgentTraceRecorder({
              model: job.model,
              provider: "openrouter",
              executionKind: "background_reference_history",
              append: (type, payload) => appendReferenceHistoryAgentEvent({
                profileId: job.profileId,
                jobId: job.id,
                threadId: scope.threadId,
                sourceRunId: scope.sourceRunId,
                sequence: sequence++,
                type,
                payload,
              }).then(() => undefined),
            });
          },
        })
      : { claimed: 0, completed: 0, conflicts: 0, skipped: 0, failed: 0, invalidated: 0 };
    return NextResponse.json({
      enabled: process.env.MEMORY_CONSOLIDATION_ENABLED === "true" || process.env.MEMORY_CONTINUITY_ENABLED === "true" || process.env.MEMORY_REFERENCE_HISTORY_ENABLED === "true",
      claimed: consolidation.claimed + continuity.claimed + referenceHistory.claimed,
      completed: consolidation.completed + continuity.completed + referenceHistory.completed,
      skipped: consolidation.skipped + continuity.skipped + referenceHistory.skipped,
      failed: consolidation.failed + continuity.failed + referenceHistory.failed,
      consolidation,
      continuity,
      referenceHistory,
    }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Consolidation worker failed." }, { status: 500 });
  }
}
