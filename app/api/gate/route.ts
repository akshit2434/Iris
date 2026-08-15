import { NextResponse } from "next/server";
import { ACCESS_COOKIE, getAppPin, getAccessToken } from "@/server/auth/gate";

export async function POST(request: Request) {
  let body: { pin?: unknown };

  try {
    body = (await request.json()) as { pin?: unknown };
  } catch {
    return NextResponse.json({ error: "Enter the app PIN." }, { status: 400 });
  }

  try {
    const appPin = getAppPin();
    if (typeof body.pin !== "string" || body.pin.length === 0 || body.pin !== appPin) {
      return NextResponse.json({ error: "That PIN is not correct." }, { status: 401 });
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.set(ACCESS_COOKIE, getAccessToken(appPin), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60 * 24 * 30,
      path: "/",
    });
    return response;
  } catch (error) {
    console.error("Iris gate is not configured", error);
    return NextResponse.json({ error: "The private gate is not configured yet." }, { status: 503 });
  }
}
