import { POST as postThreadMessage } from "../../[threadId]/messages/route";

/** First-message endpoint for the unsaved /chat/new surface. */
export async function POST(request: Request) {
  return postThreadMessage(request, { params: Promise.resolve({ threadId: "new" }) });
}
