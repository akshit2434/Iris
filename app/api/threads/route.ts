import { NextResponse } from "next/server";
import { assertAppAccess } from "@/server/auth/gate";
import { getSelectedProfile } from "@/server/auth/profile";
import { listThreads } from "@/server/db/queries";

export async function GET() {
  try {
    await assertAppAccess();
  } catch {
    return NextResponse.json({ error: "App access is required." }, { status: 401 });
  }

  try {
    const profileId = await getSelectedProfile();
    if (!profileId) {
      return NextResponse.json({ error: "Select a profile first." }, { status: 400 });
    }

    return NextResponse.json({ threads: await listThreads(profileId) });
  } catch (error) {
    console.error("Could not list Iris threads", error);
    return NextResponse.json({ error: "Could not load chats." }, { status: 500 });
  }
}

export async function POST() {
  try {
    await assertAppAccess();
  } catch {
    return NextResponse.json({ error: "App access is required." }, { status: 401 });
  }
  return NextResponse.json(
    { error: "A chat is created when its first message is submitted." },
    { status: 405, headers: { Allow: "GET" } },
  );
}
