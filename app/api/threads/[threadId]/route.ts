import { NextResponse } from "next/server";
import { assertAppAccess } from "@/server/auth/gate";
import { getSelectedProfile } from "@/server/auth/profile";
import { getThread, renameThread } from "@/server/db/queries";

type ThreadRouteContext = { params: Promise<{ threadId: string }> };

export async function GET(_request: Request, { params }: ThreadRouteContext) {
  try {
    await assertAppAccess();
  } catch {
    return NextResponse.json({ error: "App access is required." }, { status: 401 });
  }

  try {
    const profileId = await getSelectedProfile();
    const { threadId } = await params;
    if (!profileId) {
      return NextResponse.json({ error: "Select a profile first." }, { status: 400 });
    }

    const result = await getThread(profileId, threadId);
    if (!result) {
      return NextResponse.json({ error: "Chat not found." }, { status: 404 });
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("Could not load Iris thread", error);
    return NextResponse.json({ error: "Could not load this chat." }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: ThreadRouteContext) {
  try {
    await assertAppAccess();
  } catch {
    return NextResponse.json({ error: "App access is required." }, { status: 401 });
  }

  try {
    const profileId = await getSelectedProfile();
    const { threadId } = await params;
    if (!profileId) {
      return NextResponse.json({ error: "Select a profile first." }, { status: 400 });
    }

    const body = (await request.json()) as { title?: unknown };
    if (typeof body.title !== "string" || body.title.trim().length === 0) {
      return NextResponse.json({ error: "Enter a chat title." }, { status: 400 });
    }

    const thread = await renameThread(profileId, threadId, body.title);
    if (!thread) {
      return NextResponse.json({ error: "Chat not found." }, { status: 404 });
    }

    return NextResponse.json({ thread });
  } catch (error) {
    console.error("Could not rename Iris thread", error);
    return NextResponse.json({ error: "Could not rename this chat." }, { status: 500 });
  }
}
