import { NextResponse } from "next/server";
import { assertAppAccess } from "@/server/auth/gate";
import { getSelectedProfile } from "@/server/auth/profile";
import { createSupabaseReferenceHistoryStore } from "@/server/memory/reference-history-repository";

export async function GET() {
  try { await assertAppAccess(); } catch { return NextResponse.json({ error: "App access is required." }, { status: 401 }); }
  try {
    const profileId = await getSelectedProfile();
    if (!profileId) return NextResponse.json({ error: "Select a profile first." }, { status: 400 });
    const controls = await createSupabaseReferenceHistoryStore().getControls(profileId);
    return NextResponse.json({ controls }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not load memory settings." }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try { await assertAppAccess(); } catch { return NextResponse.json({ error: "App access is required." }, { status: 401 }); }
  try {
    const profileId = await getSelectedProfile();
    if (!profileId) return NextResponse.json({ error: "Select a profile first." }, { status: 400 });
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || (body.savedMemoryEnabled !== undefined && typeof body.savedMemoryEnabled !== "boolean") || (body.referenceHistoryEnabled !== undefined && typeof body.referenceHistoryEnabled !== "boolean")) {
      return NextResponse.json({ error: "Each memory setting must be a boolean." }, { status: 400 });
    }
    if (body.savedMemoryEnabled === undefined && body.referenceHistoryEnabled === undefined) {
      return NextResponse.json({ error: "Choose a memory setting to update." }, { status: 400 });
    }
    const controls = await createSupabaseReferenceHistoryStore().updateControls?.({
      profileId,
      ...(body.savedMemoryEnabled === undefined ? {} : { savedMemoryEnabled: body.savedMemoryEnabled }),
      ...(body.referenceHistoryEnabled === undefined ? {} : { referenceHistoryEnabled: body.referenceHistoryEnabled }),
    });
    if (!controls) return NextResponse.json({ error: "Memory settings are unavailable." }, { status: 500 });
    return NextResponse.json({ controls }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not update memory settings." }, { status: 500 });
  }
}
