import { NextResponse } from "next/server";
import { POST as runMemoryWorker } from "../../memory/consolidate/route";
import { runAccountabilitySweep, type SweepReport } from "@/server/accountability/sweeper";
import { hasWorkerSecret } from "@/server/memory/worker-auth";

export const runtime = "nodejs";
export const maxDuration = 300;

const MEMORY_LIMIT = 1;
const ACCOUNTABILITY_LIMIT_PER_PROFILE = 8;

type SafeCounts = Record<string, number>;

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isCronAuthorized(request: Request): boolean {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return false;
  const configuredSecret = process.env.SUPABASE_CRON_SECRET ?? process.env.CRON_SECRET;
  return hasWorkerSecret(authorization.slice("Bearer ".length), configuredSecret);
}

async function invokeMemoryWorker(request: Request): Promise<{ status: number; body: unknown }> {
  const response = await runMemoryWorker(new Request(request.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-iris-worker-secret": process.env.MEMORY_WORKER_SECRET ?? "",
    },
    body: JSON.stringify({ limit: MEMORY_LIMIT }),
  }));
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

function summarizeMemory(result: { status: number; body: unknown }): SafeCounts {
  const body = result.body && typeof result.body === "object" ? result.body as Record<string, unknown> : {};
  return {
    claimed: numberOrZero(body.claimed),
    completed: numberOrZero(body.completed),
    skipped: numberOrZero(body.skipped),
    failed: numberOrZero(body.failed) + (result.status >= 400 ? 1 : 0),
  };
}

function summarizeAccountability(report: SweepReport): SafeCounts {
  const counts: SafeCounts = {
    selected: 0,
    delivered: 0,
    mergedBatches: 0,
    cancelledStale: 0,
    cancelledOrphans: 0,
    skippedNoThread: 0,
    suppressed: 0,
    failed: 0,
  };
  for (const profile of report.profiles) {
    for (const key of Object.keys(counts)) counts[key] += numberOrZero(profile[key as keyof typeof profile]);
  }
  return counts;
}

function failedAccountability(): SafeCounts {
  return {
    selected: 0,
    delivered: 0,
    mergedBatches: 0,
    cancelledStale: 0,
    cancelledOrphans: 0,
    skippedNoThread: 0,
    suppressed: 0,
    failed: 1,
  };
}

/**
 * Scheduler's narrow GET adapter. The scheduler secret is separate from the
 * existing POST worker secret; no worker endpoint is changed to GET.
 */
export async function GET(request: Request) {
  if (!isCronAuthorized(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const [memoryResult, accountabilityResult] = await Promise.allSettled([
    invokeMemoryWorker(request),
    runAccountabilitySweep({ limitPerProfile: ACCOUNTABILITY_LIMIT_PER_PROFILE }),
  ]);
  const memory = memoryResult.status === "fulfilled"
    ? summarizeMemory(memoryResult.value)
    : { claimed: 0, completed: 0, skipped: 0, failed: 1 };
  const accountability = accountabilityResult.status === "fulfilled"
    ? summarizeAccountability(accountabilityResult.value)
    : failedAccountability();
  const invocationFailed = memoryResult.status === "rejected"
    || accountabilityResult.status === "rejected"
    || (memoryResult.status === "fulfilled" && memoryResult.value.status >= 400);

  return NextResponse.json({
    ok: !invocationFailed,
    at: new Date().toISOString(),
    memory,
    accountability,
  }, {
    status: invocationFailed ? 500 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}
