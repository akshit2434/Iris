import { NextResponse } from "next/server";
import { createProductionConsolidationWorker } from "@/server/memory/consolidation";
import { hasWorkerSecret as compareWorkerSecret } from "@/server/memory/worker-auth";

export const runtime = "nodejs";

export function hasWorkerSecret(request: Request) {
  const supplied = request.headers.get("x-iris-worker-secret") ?? "";
  return compareWorkerSecret(supplied);
}

export async function POST(request: Request) {
  if (!hasWorkerSecret(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (process.env.MEMORY_CONSOLIDATION_ENABLED !== "true") {
    return NextResponse.json({ enabled: false, claimed: 0, completed: 0, skipped: 0, failed: 0 }, { status: 200 });
  }
  try {
    const body = (await request.json().catch(() => ({}))) as { limit?: unknown };
    const limit = typeof body.limit === "number" && Number.isInteger(body.limit) ? Math.min(Math.max(body.limit, 1), 3) : 1;
    const result = await createProductionConsolidationWorker({ limit, maxDurationMs: 25_000, workerId: `http-${crypto.randomUUID()}` });
    return NextResponse.json(result, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Consolidation worker failed." }, { status: 500 });
  }
}
