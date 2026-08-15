import "server-only";

import type { ProfileId } from "@/lib/profiles";
import type { Message, PersistedToolEvent, Thread } from "@/lib/types";
import { getDatabase } from "@/server/db/client";
import type { Json } from "@/server/db/types";
import { sanitizeForEvent, sanitizeStatusMessage } from "@/server/agent/protocol";
import { deriveThreadTitle } from "@/lib/thread-title";

export type ProfileSummary = {
  id: ProfileId;
  displayName: string;
};

export type AgentRunStatus = "running" | "completed" | "failed";
export type AgentEventType =
  | "run_started"
  | "run_completed"
  | "run_failed"
  | "tool_call"
  | "tool_result";

export type AgentRun = {
  id: string;
  profileId: ProfileId;
  threadId: string;
  requestId: string;
  userMessageId: string | null;
  assistantMessageId: string | null;
  model: string;
  status: AgentRunStatus;
  startedAt: string;
  completedAt: string | null;
  failedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorMetadata: Record<string, unknown>;
  createdAt: string;
};

export async function listProfiles(): Promise<ProfileSummary[]> {
  const { data, error } = await getDatabase()
    .from("profiles")
    .select("id, display_name")
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []).map((profile) => ({
    id: profile.id,
    displayName: profile.display_name,
  }));
}

export async function getProfile(profileId: ProfileId): Promise<ProfileSummary | null> {
  const { data, error } = await getDatabase()
    .from("profiles")
    .select("id, display_name")
    .eq("id", profileId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data
    ? { id: data.id, displayName: data.display_name }
    : null;
}

function toThread(row: {
  id: string;
  profile_id: ProfileId;
  title: string;
  title_source: Thread["titleSource"];
  title_generation_attempted: boolean;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}): Thread {
  return {
    id: row.id,
    profileId: row.profile_id,
    title: row.title,
    titleSource: row.title_source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function toMessage(row: {
  id: string;
  thread_id: string;
  profile_id: ProfileId;
  role: Message["role"];
  content: string;
  agent_run_id?: string | null;
  is_complete?: boolean;
  created_at: string;
}): Message {
  return {
    id: row.id,
    threadId: row.thread_id,
    profileId: row.profile_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    agentRunId: row.agent_run_id,
    isComplete: row.is_complete,
  };
}

function toAgentRun(row: {
  id: string;
  profile_id: ProfileId;
  thread_id: string;
  request_id: string;
  user_message_id: string | null;
  assistant_message_id: string | null;
  model: string;
  status: AgentRunStatus;
  started_at: string;
  completed_at: string | null;
  failed_at: string | null;
  error_code: string | null;
  error_message: string | null;
  error_metadata: unknown;
  created_at: string;
}): AgentRun {
  return {
    id: row.id,
    profileId: row.profile_id,
    threadId: row.thread_id,
    requestId: row.request_id,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    model: row.model,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    errorMetadata:
      typeof row.error_metadata === "object" && row.error_metadata !== null
        ? (row.error_metadata as Record<string, unknown>)
        : {},
    createdAt: row.created_at,
  };
}

function toPersistedToolEvent(row: {
  run_id: string;
  sequence: number;
  type: AgentEventType;
  payload: unknown;
  created_at: string;
}): PersistedToolEvent | null {
  if (row.type !== "tool_call" && row.type !== "tool_result") return null;
  const payload = typeof row.payload === "object" && row.payload !== null && !Array.isArray(row.payload)
    ? row.payload as Record<string, unknown>
    : {};
  if (typeof payload.toolCallId !== "string" || payload.toolCallId.length === 0 || typeof payload.toolName !== "string" || payload.toolName.length === 0) {
    return null;
  }

  return row.type === "tool_call"
    ? {
        runId: row.run_id,
        sequence: row.sequence,
        type: row.type,
        toolCallId: payload.toolCallId.slice(0, 200),
        toolName: payload.toolName.slice(0, 200),
        ...(Object.prototype.hasOwnProperty.call(payload, "input")
          ? { input: sanitizeForEvent(payload.input) as PersistedToolEvent["input"] }
          : {}),
        ...(sanitizeStatusMessage(payload.statusMessage)
          ? { statusMessage: sanitizeStatusMessage(payload.statusMessage) }
          : {}),
        createdAt: row.created_at,
      }
    : {
        runId: row.run_id,
        sequence: row.sequence,
        type: row.type,
        toolCallId: payload.toolCallId.slice(0, 200),
        toolName: payload.toolName.slice(0, 200),
        ...(Object.prototype.hasOwnProperty.call(payload, "output")
          ? { output: sanitizeForEvent(payload.output) as PersistedToolEvent["output"] }
          : {}),
        ...(sanitizeStatusMessage(payload.statusMessage)
          ? { statusMessage: sanitizeStatusMessage(payload.statusMessage) }
          : {}),
        ok: payload.ok === true,
        createdAt: row.created_at,
      };
}

const AGENT_RUN_COLUMNS =
  "id, profile_id, thread_id, request_id, user_message_id, assistant_message_id, model, status, started_at, completed_at, failed_at, error_code, error_message, error_metadata, created_at";

export async function listThreads(profileId: ProfileId) {
  const { data, error } = await getDatabase()
    .from("threads")
    .select("id, profile_id, title, title_source, title_generation_attempted, created_at, updated_at, archived_at")
    .eq("profile_id", profileId)
    .is("archived_at", null)
    .order("updated_at", { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? []).map(toThread);
}

export async function createThread(profileId: ProfileId) {
  const { data, error } = await getDatabase()
    .from("threads")
    .insert({ profile_id: profileId, title: "New chat" })
    .select("id, profile_id, title, title_source, title_generation_attempted, created_at, updated_at, archived_at")
    .single();

  if (error) {
    throw error;
  }

  return toThread(data);
}

export async function getThread(profileId: ProfileId, threadId: string) {
  const { data: thread, error: threadError } = await getDatabase()
    .from("threads")
    .select("id, profile_id, title, title_source, title_generation_attempted, created_at, updated_at, archived_at")
    .eq("id", threadId)
    .eq("profile_id", profileId)
    .maybeSingle();

  if (threadError) {
    throw threadError;
  }
  if (!thread) {
    return null;
  }

  const [messages, toolActivities] = await Promise.all([
    getThreadMessages(profileId, threadId),
    getThreadToolEvents(profileId, threadId),
  ]);

  return { thread: toThread(thread), messages, toolActivities };
}

export async function getThreadMessages(profileId: ProfileId, threadId: string) {
  const { data, error } = await getDatabase()
    .from("messages")
    .select("id, thread_id, profile_id, role, content, agent_run_id, is_complete, created_at")
    .eq("thread_id", threadId)
    .eq("profile_id", profileId)
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []).map(toMessage);
}

/** Return only sanitized tool events owned by this profile and thread. */
export async function getThreadToolEvents(profileId: ProfileId, threadId: string) {
  const { data, error } = await getDatabase()
    .from("agent_events")
    .select("run_id, sequence, type, payload, created_at")
    .eq("profile_id", profileId)
    .eq("thread_id", threadId)
    .in("type", ["tool_call", "tool_result"])
    .order("created_at", { ascending: true })
    .order("run_id", { ascending: true })
    .order("sequence", { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? [])
    .map((row) => toPersistedToolEvent(row as {
      run_id: string;
      sequence: number;
      type: AgentEventType;
      payload: unknown;
      created_at: string;
    }))
    .filter((event): event is PersistedToolEvent => event !== null);
}

export async function getThreadContext(profileId: ProfileId, threadId: string) {
  const { data, error } = await getDatabase()
    .from("thread_context")
    .select("continuity_summary, pinned_notes, memory_revision_seen, compacted_through_message_id, compacted_through_created_at, continuity_revision")
    .eq("profile_id", profileId)
    .eq("thread_id", threadId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data
    ? {
      continuitySummary: data.continuity_summary,
      pinnedNotes: data.pinned_notes,
      memoryRevisionSeen: data.memory_revision_seen,
      compactedThroughMessageId: data.compacted_through_message_id,
      compactedThroughCreatedAt: data.compacted_through_created_at,
      continuityRevision: data.continuity_revision,
      }
    : {
        continuitySummary: null,
        pinnedNotes: [],
        memoryRevisionSeen: 0,
        compactedThroughMessageId: null,
        compactedThroughCreatedAt: null,
        continuityRevision: 0,
      };
}

export async function getThreadOverview(profileId: ProfileId, threadId: string) {
  const { data: thread, error: threadError } = await getDatabase()
    .from("threads")
    .select("title, created_at, updated_at")
    .eq("id", threadId)
    .eq("profile_id", profileId)
    .maybeSingle();

  if (threadError) {
    throw threadError;
  }
  if (!thread) {
    return null;
  }

  const { count, error: messageError } = await getDatabase()
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("thread_id", threadId)
    .eq("profile_id", profileId);

  if (messageError) {
    throw messageError;
  }

  return {
    title: thread.title,
    createdAt: thread.created_at,
    updatedAt: thread.updated_at,
    messageCount: count ?? 0,
  };
}

export async function createMessage(input: {
  id: string;
  profileId: ProfileId;
  threadId: string;
  role: Message["role"];
  content: string;
  agentRunId?: string | null;
  isComplete?: boolean;
}) {
  const { data, error } = await getDatabase()
    .from("messages")
    .insert({
      id: input.id,
      thread_id: input.threadId,
      profile_id: input.profileId,
      role: input.role,
      content: input.content,
      agent_run_id: input.agentRunId ?? null,
      is_complete: input.isComplete ?? true,
    })
    .select("id, thread_id, profile_id, role, content, agent_run_id, is_complete, created_at")
    .single();

  if (error) {
    throw error;
  }

  return toMessage(data);
}

export async function findAgentRun(
  profileId: ProfileId,
  threadId: string,
  requestId: string,
): Promise<AgentRun | null> {
  const { data, error } = await getDatabase()
    .from("agent_runs")
    .select(AGENT_RUN_COLUMNS)
    .eq("profile_id", profileId)
    .eq("thread_id", threadId)
    .eq("request_id", requestId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? toAgentRun(data) : null;
}

export async function createAgentRun(input: {
  id: string;
  profileId: ProfileId;
  threadId: string;
  requestId: string;
  model: string;
  startedAt?: string;
}): Promise<AgentRun> {
  const { data, error } = await getDatabase()
    .from("agent_runs")
    .insert({
      id: input.id,
      profile_id: input.profileId,
      thread_id: input.threadId,
      request_id: input.requestId,
      model: input.model,
      status: "running",
      started_at: input.startedAt,
    })
    .select(AGENT_RUN_COLUMNS)
    .single();

  if (error) {
    throw error;
  }

  return toAgentRun(data);
}

export async function linkAgentRunMessages(
  profileId: ProfileId,
  threadId: string,
  runId: string,
  refs: { userMessageId?: string | null; assistantMessageId?: string | null },
) {
  const { data, error } = await getDatabase()
    .from("agent_runs")
    .update({
      ...(refs.userMessageId !== undefined ? { user_message_id: refs.userMessageId } : {}),
      ...(refs.assistantMessageId !== undefined
        ? { assistant_message_id: refs.assistantMessageId }
        : {}),
    })
    .eq("id", runId)
    .eq("profile_id", profileId)
    .eq("thread_id", threadId)
    .select(AGENT_RUN_COLUMNS)
    .single();

  if (error) {
    throw error;
  }

  return toAgentRun(data);
}

export async function appendAgentEvent(input: {
  id?: string;
  profileId: ProfileId;
  threadId: string;
  runId: string;
  sequence: number;
  type: AgentEventType;
  payload: Record<string, unknown>;
  createdAt?: string;
}) {
  const { data, error } = await getDatabase()
    .from("agent_events")
    .insert({
      id: input.id,
      profile_id: input.profileId,
      thread_id: input.threadId,
      run_id: input.runId,
      sequence: input.sequence,
      type: input.type,
      payload: input.payload as Json,
      created_at: input.createdAt,
    })
    .select("id, profile_id, thread_id, run_id, sequence, type, payload, created_at")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

export async function updateAgentRunStatus(input: {
  profileId: ProfileId;
  threadId: string;
  runId: string;
  status: AgentRunStatus;
  completedAt?: string | null;
  failedAt?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  errorMetadata?: Record<string, unknown>;
}) {
  const { data, error } = await getDatabase()
    .from("agent_runs")
    .update({
      status: input.status,
      completed_at: input.completedAt,
      failed_at: input.failedAt,
      error_code: input.errorCode,
      error_message: input.errorMessage,
      error_metadata: (input.errorMetadata ?? {}) as Json,
    })
    .eq("id", input.runId)
    .eq("profile_id", input.profileId)
    .eq("thread_id", input.threadId)
    .select(AGENT_RUN_COLUMNS)
    .single();

  if (error) {
    throw error;
  }

  return toAgentRun(data);
}

export async function renameThread(profileId: ProfileId, threadId: string, title: string) {
  const { data, error } = await getDatabase()
    .from("threads")
    .update({ title: title.trim().slice(0, 120), title_source: "manual", title_generation_attempted: true })
    .eq("id", threadId)
    .eq("profile_id", profileId)
    .select("id, profile_id, title, title_source, title_generation_attempted, created_at, updated_at, archived_at")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? toThread(data) : null;
}

/** Claim the single automatic-title attempt; the update is the race guard. */
export async function claimAutomaticThreadTitle(profileId: ProfileId, threadId: string) {
  const { data, error } = await getDatabase()
    .from("threads")
    .update({ title_generation_attempted: true })
    .eq("id", threadId)
    .eq("profile_id", profileId)
    .eq("title", "New chat")
    .eq("title_source", "default")
    .eq("title_generation_attempted", false)
    .select("id, profile_id, title, title_source, title_generation_attempted, created_at, updated_at, archived_at")
    .maybeSingle();

  if (error) throw error;
  return data ? toThread(data) : null;
}

/** Apply a generated title only while the thread is still eligible. */
export async function applyAutomaticThreadTitle(profileId: ProfileId, threadId: string, title: string) {
  const { data, error } = await getDatabase()
    .from("threads")
    .update({ title: title.trim().slice(0, 120), title_source: "automatic" })
    .eq("id", threadId)
    .eq("profile_id", profileId)
    .eq("title", "New chat")
    .eq("title_source", "default")
    .eq("title_generation_attempted", true)
    .select("id, profile_id, title, title_source, title_generation_attempted, created_at, updated_at, archived_at")
    .maybeSingle();

  if (error) throw error;
  return data ? toThread(data) : null;
}

export async function touchThread(profileId: ProfileId, threadId: string) {
  const { error } = await getDatabase()
    .from("threads")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", threadId)
    .eq("profile_id", profileId);

  if (error) {
    throw error;
  }
}

export { deriveThreadTitle };
