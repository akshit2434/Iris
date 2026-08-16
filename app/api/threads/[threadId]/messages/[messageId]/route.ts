import { NextResponse } from "next/server";
import { assertAppAccess } from "@/server/auth/gate";
import { getSelectedProfile } from "@/server/auth/profile";
import { createProductionMemoryRetrievalService } from "@/server/memory/retrieval";

type SourcePreviewRouteContext = {
  params: Promise<{ threadId: string; messageId: string }>;
};

/** Return a small, profile-scoped context window for an exact historical source. */
export async function GET(_request: Request, { params }: SourcePreviewRouteContext) {
  try {
    await assertAppAccess();
  } catch {
    return NextResponse.json({ error: "App access is required." }, { status: 401 });
  }

  try {
    const profileId = await getSelectedProfile();
    if (!profileId) return NextResponse.json({ error: "Select a profile first." }, { status: 400 });
    const { threadId, messageId } = await params;
    const context = await createProductionMemoryRetrievalService().readMessages(profileId, messageId, 3);
    const contextMessages = context ? [...context.before, context.target, ...context.after] : [];
    if (!context
      || context.thread.id !== threadId
      || context.thread.profileId !== profileId
      || context.target.messageId !== messageId
      || context.target.threadId !== threadId
      || context.target.profileId !== profileId
      || !contextMessages.every((message) => message.threadId === threadId && message.profileId === profileId)) {
      return NextResponse.json({ error: "Source message is no longer available." }, { status: 404 });
    }
    return NextResponse.json({ source: context });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/UUID/i.test(message)) return NextResponse.json({ error: "Source message is invalid." }, { status: 400 });
    console.error("Could not load Iris source preview", error);
    return NextResponse.json({ error: "Could not load this source preview." }, { status: 500 });
  }
}
