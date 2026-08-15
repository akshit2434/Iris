import { NextResponse } from "next/server";
import { assertAppAccess } from "@/server/auth/gate";
import { listProfiles } from "@/server/db/queries";

export async function GET() {
  try {
    await assertAppAccess();
    return NextResponse.json({ profiles: await listProfiles() });
  } catch {
    return NextResponse.json({ error: "Could not load profiles." }, { status: 500 });
  }
}
