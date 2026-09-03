import { NextResponse } from "next/server";
import { assertAppAccess } from "@/server/auth/gate";
import { getSelectedProfile } from "@/server/auth/profile";
import { createOnboardingRepository } from "@/server/onboarding/repository";

export async function GET() {
  try { await assertAppAccess(); } catch { return NextResponse.json({ error: "App access is required." }, { status: 401 }); }
  try {
    const profileId = await getSelectedProfile();
    if (!profileId) return NextResponse.json({ error: "Select a profile first." }, { status: 400 });
    const onboarding = await createOnboardingRepository().loadSnapshot(profileId);
    return NextResponse.json({ onboarding }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not load onboarding." }, { status: 500 });
  }
}
