import { NextResponse } from "next/server";
import { BriefingItemNotActionableError, createProductionAccountabilityRepository } from "@/server/accountability/repository";
import { respondInputSchema } from "@/server/accountability/types";
import { assertAppAccess } from "@/server/auth/gate";
import { getSelectedProfile } from "@/server/auth/profile";

export async function POST(request: Request) {
  try { await assertAppAccess(); } catch { return NextResponse.json({ error: "App access is required." }, { status: 401 }); }
  try {
    const profileId = await getSelectedProfile();
    if (!profileId) return NextResponse.json({ error: "Select a profile first." }, { status: 401 });
    const parsed = respondInputSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Respond payload is invalid." }, { status: 400 });
    try {
      const result = await createProductionAccountabilityRepository().respondToDeliveryItem(profileId, parsed.data);
      return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/has no question|was not found/.test(message)) {
        return NextResponse.json({ error: "That check-in question no longer exists." }, { status: 404 });
      }
      if (error instanceof BriefingItemNotActionableError) {
        return NextResponse.json({ error: "Morning briefings are informational and don't need a response." }, { status: 409 });
      }
      throw error;
    }
  } catch {
    return NextResponse.json({ error: "Could not record your response." }, { status: 500 });
  }
}
