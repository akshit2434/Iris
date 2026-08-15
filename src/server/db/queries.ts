import "server-only";

import type { ProfileId } from "@/lib/profiles";
import type { Message, Thread } from "@/lib/types";
import { getDatabase } from "@/server/db/client";

export type ProfileSummary = {
  id: ProfileId;
  displayName: string;
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

function toThread(row: {
  id: string;
  profile_id: ProfileId;
  title: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}): Thread {
  return {
    id: row.id,
    profileId: row.profile_id,
    title: row.title,
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
  created_at: string;
}): Message {
  return {
    id: row.id,
    threadId: row.thread_id,
    profileId: row.profile_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}

export async function listThreads(profileId: ProfileId) {
  const { data, error } = await getDatabase()
    .from("threads")
    .select("id, profile_id, title, created_at, updated_at, archived_at")
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
    .select("id, profile_id, title, created_at, updated_at, archived_at")
    .single();

  if (error) {
    throw error;
  }

  return toThread(data);
}

export async function getThread(profileId: ProfileId, threadId: string) {
  const { data: thread, error: threadError } = await getDatabase()
    .from("threads")
    .select("id, profile_id, title, created_at, updated_at, archived_at")
    .eq("id", threadId)
    .eq("profile_id", profileId)
    .maybeSingle();

  if (threadError) {
    throw threadError;
  }
  if (!thread) {
    return null;
  }

  return {
    thread: toThread(thread),
    messages: await getThreadMessages(profileId, threadId),
  };
}

export async function getThreadMessages(profileId: ProfileId, threadId: string) {
  const { data, error } = await getDatabase()
    .from("messages")
    .select("id, thread_id, profile_id, role, content, created_at")
    .eq("thread_id", threadId)
    .eq("profile_id", profileId)
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []).map(toMessage);
}

export async function createMessage(input: {
  id: string;
  profileId: ProfileId;
  threadId: string;
  role: Message["role"];
  content: string;
}) {
  const { data, error } = await getDatabase()
    .from("messages")
    .insert({
      id: input.id,
      thread_id: input.threadId,
      profile_id: input.profileId,
      role: input.role,
      content: input.content,
    })
    .select("id, thread_id, profile_id, role, content, created_at")
    .single();

  if (error) {
    throw error;
  }

  return toMessage(data);
}

export async function renameThread(profileId: ProfileId, threadId: string, title: string) {
  const { data, error } = await getDatabase()
    .from("threads")
    .update({ title: title.trim().slice(0, 120) })
    .eq("id", threadId)
    .eq("profile_id", profileId)
    .select("id, profile_id, title, created_at, updated_at, archived_at")
    .maybeSingle();

  if (error) {
    throw error;
  }

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

export function deriveThreadTitle(content: string) {
  const title = content.replace(/\s+/g, " ").trim();
  return title.length > 48 ? `${title.slice(0, 48).trimEnd()}…` : title;
}
