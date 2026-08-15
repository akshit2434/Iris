import "server-only";

import { ChatOpenRouter } from "@langchain/openrouter";
import { createAgent } from "langchain";
import type { ProfileId } from "@/lib/profiles";

export const DEFAULT_MODEL = "openai/gpt-5.6-luna";

const MINIMAL_SYSTEM_PROMPT = `You are Iris, a private personal conversation layer.
Be concise, thoughtful, and directly useful. You do not have memory tools or external tools in this first version, so never claim to have looked something up or remembered information unless it is present in the current conversation.`;

type AgentMessage = {
  role: "user" | "assistant";
  content: string;
};

type AgentInput = {
  profileId: ProfileId;
  messages: AgentMessage[];
};

function getModel() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is required.");
  }

  return new ChatOpenRouter({
    apiKey,
    model: process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL,
    temperature: 0.2,
  });
}

function getTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      if (typeof block === "object" && block !== null && "text" in block) {
        const text = (block as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .join("");
}

export async function* streamAssistantReply(input: AgentInput) {
  // The profile is part of the boundary now so future context/memory layers cannot
  // accidentally run without an explicit private runtime scope.
  void input.profileId;

  const agent = createAgent({
    model: getModel(),
    systemPrompt: MINIMAL_SYSTEM_PROMPT,
  });

  const stream = await agent.stream(
    {
      messages: input.messages,
    },
    { streamMode: "messages" },
  );

  for await (const chunk of stream) {
    const message = Array.isArray(chunk) ? chunk[0] : chunk;
    const text = getTextContent((message as { content?: unknown }).content);
    if (text) {
      yield text;
    }
  }
}
