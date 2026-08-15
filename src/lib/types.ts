import type { ProfileId } from "@/lib/profiles";

export type MessageRole = "user" | "assistant" | "tool";

export type Thread = {
  id: string;
  profileId: ProfileId;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type Message = {
  id: string;
  threadId: string;
  profileId: ProfileId;
  role: MessageRole;
  content: string;
  createdAt: string;
};
