import { NextResponse } from "next/server";
import { assertAppAccess } from "@/server/auth/gate";
import { PROFILE_COOKIE, isProfileId } from "@/lib/profiles";
import { cookies } from "next/headers";

export async function POST(request: Request) {
  try {
    await assertAppAccess();
  } catch {
    return NextResponse.json({ error: "App access is required." }, { status: 401 });
  }

  let body: { profileId?: unknown };
  try {
    body = (await request.json()) as { profileId?: unknown };
  } catch {
    return NextResponse.json({ error: "Choose a valid profile." }, { status: 400 });
  }

  const cookieStore = await cookies();
  if (body.profileId === null) {
    cookieStore.delete(PROFILE_COOKIE);
    return NextResponse.json({ profileId: null });
  }

  if (!isProfileId(body.profileId)) {
    return NextResponse.json({ error: "Choose a valid profile." }, { status: 400 });
  }

  cookieStore.set(PROFILE_COOKIE, body.profileId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
  });

  return NextResponse.json({ profileId: body.profileId });
}
