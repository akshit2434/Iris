import { NextResponse } from "next/server";
import { DEFAULT_LIMIT_PER_PROFILE, runAccountabilitySweep } from "@/server/accountability/sweeper";
import { assertAppAccess } from "@/server/auth/gate";
import { getSelectedProfile } from "@/server/auth/profile";

/** Profile-cookie scoped, database-first wake sweep. */
export async function POST() {
  try { await assertAppAccess(); } catch { return NextResponse.json({ error: "App access is required." }, { status: 401 }); }
  try {
    const profileId = await getSelectedProfile();
    if (!profileId) return NextResponse.json({ error: "Select a profile first." }, { status: 401 });
    const report = await runAccountabilitySweep({ profiles: [profileId], limitPerProfile: DEFAULT_LIMIT_PER_PROFILE });
    const profile = report.profiles[0];
    return NextResponse.json({ delivered: profile?.delivered ?? 0, affectedThreadIds: [], composition: profile?.failed ? "failed" : "none" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not refresh follow-ups." }, { status: 500 });
  }
}
