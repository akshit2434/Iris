import { NextResponse } from "next/server";
import { createProductionConsolidationWorker } from "@/server/memory/consolidation";
import { createProductionThreadContinuityWorker } from "@/server/memory/compaction";
import { hasWorkerSecret as compareWorkerSecret } from "@/server/memory/worker-auth";

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
    return NextResponse.json({
      enabled: process.env.MEMORY_CONSOLIDATION_ENABLED === "true" || process.env.MEMORY_CONTINUITY_ENABLED === "true",
      claimed: consolidation.claimed + continuity.claimed,
      completed: consolidation.completed + continuity.completed,
      skipped: consolidation.skipped + continuity.skipped,
      failed: consolidation.failed + continuity.failed,
      consolidation,
      continuity,
    }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Consolidation worker failed." }, { status: 500 });
  }
}
