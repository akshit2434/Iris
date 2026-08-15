import type { ProfileId } from "@/lib/profiles";

export type MessageRole = "user" | "assistant" | "tool";

export type Thread = {
  id: string;
  profileId: ProfileId;
  title: string;
  titleSource: "default" | "automatic" | "manual";
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
  agentRunId?: string | null;
  isComplete?: boolean;
};

export type SafeToolJson =
  | string
  | number
  | boolean
  | null
  | SafeToolJson[]
  | { [key: string]: SafeToolJson };

export type PersistedToolEvent = {
  runId: string;
  sequence: number;
  type: "tool_call" | "tool_result";
  toolCallId: string;
  toolName: string;
  input?: SafeToolJson;
  output?: SafeToolJson;
  statusMessage?: string;
  ok?: boolean;
  createdAt: string;
};

export type ToolActivity = {
  runId: string;
  toolCallId: string;
  toolName: string;
  input?: SafeToolJson;
  output?: SafeToolJson;
  statusMessage?: string;
  status: "running" | "succeeded" | "failed";
  startedAt?: string;
  finishedAt?: string;
};
