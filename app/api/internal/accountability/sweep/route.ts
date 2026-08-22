import { NextResponse } from "next/server";
import { DEFAULT_LIMIT_PER_PROFILE, runAccountabilitySweep } from "@/server/accountability/sweeper";
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
    const limit = typeof body.limit === "number" && Number.isInteger(body.limit) ? Math.min(Math.max(body.limit, 1), 8) : DEFAULT_LIMIT_PER_PROFILE;
    const report = await runAccountabilitySweep({ limitPerProfile: limit });
    return NextResponse.json(report, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Accountability sweep failed." }, { status: 500 });
  }
}
