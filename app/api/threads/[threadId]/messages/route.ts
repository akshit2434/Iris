import { NextResponse } from "next/server";
import { assertAppAccess } from "@/server/auth/gate";
import { getSelectedProfile } from "@/server/auth/profile";
import { streamAssistantReply } from "@/server/agent";
import {
  createMessage,
  deriveThreadTitle,
  getThread,
  getThreadMessages,
  renameThread,
  touchThread,
} from "@/server/db/queries";

type MessagesRouteContext = { params: Promise<{ threadId: string }> };
type MessageRequest = { content?: unknown };

function ndjson(data: Record<string, unknown>) {
  return `${JSON.stringify(data)}\n`;
}

export async function POST(request: Request, { params }: MessagesRouteContext) {
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

    const body = (await request.json()) as MessageRequest;
    if (typeof body.content !== "string" || body.content.trim().length === 0) {
      return NextResponse.json({ error: "Enter a message first." }, { status: 400 });
    }

    const content = body.content.trim().slice(0, 12000);
    const thread = await getThread(profileId, threadId);
    if (!thread) {
      return NextResponse.json({ error: "Chat not found." }, { status: 404 });
    }

    const userMessageId = crypto.randomUUID();
    await createMessage({
      id: userMessageId,
      profileId,
      threadId,
      role: "user",
      content,
    });

    if (thread.thread.title === "New chat") {
      await renameThread(profileId, threadId, deriveThreadTitle(content));
    }

    const history = await getThreadMessages(profileId, threadId);
    const assistantMessageId = crypto.randomUUID();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        let assistantContent = "";
        controller.enqueue(
          encoder.encode(
            ndjson({ type: "start", userMessageId, assistantMessageId }),
          ),
        );

        try {
          for await (const delta of streamAssistantReply({
            profileId,
              messages: history
                .filter((message) => message.role === "user" || message.role === "assistant")
              .map((message) => ({
                role: message.role === "user" ? ("user" as const) : ("assistant" as const),
                content: message.content,
              })),
          })) {
            assistantContent += delta;
            controller.enqueue(encoder.encode(ndjson({ type: "delta", text: delta })));
          }

          if (assistantContent.trim().length === 0) {
            throw new Error("The model returned an empty response.");
          }

          await createMessage({
            id: assistantMessageId,
            profileId,
            threadId,
            role: "assistant",
            content: assistantContent,
          });
          await touchThread(profileId, threadId);
          controller.enqueue(
            encoder.encode(
              ndjson({ type: "done", messageId: assistantMessageId }),
            ),
          );
        } catch (error) {
          console.error("Iris assistant stream failed", error);
          controller.enqueue(
            encoder.encode(
              ndjson({
                type: "error",
                message: "I could not reach the assistant. Check the server configuration and try again.",
              }),
            ),
          );
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    console.error("Could not start Iris assistant stream", error);
    return NextResponse.json({ error: "Could not send that message." }, { status: 500 });
  }
}
