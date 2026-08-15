import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getDatabase } from "@/server/db/client";
import type { Database, Json } from "@/server/db/types";
import {
  type AppliedMemoryDocumentRevision,
  type CanonicalDocumentSearchResult,
  type CanonicalMemoryDocument,
  type MessageContextItem,
  type MessageContextWindow,
  type MemoryProvenanceInput,
  type MessageEmbeddingMetadata,
  type MessageSearchResult,
  type MemoryStore,
  type MessageSemanticIndexStore,
} from "@/server/memory/types";
import { assertMemoryProfileId, normalizeMemoryLimit, normalizeMemoryQuery, validateApplyMemoryDocumentRevision, validateEmbedding, validateEmbeddingModel, validateLogicalKey, validateMemoryUuid } from "@/server/memory/validation";

type MemoryDatabase = SupabaseClient<Database>;

function toDocument(row: Database["public"]["Tables"]["memory_documents"]["Row"]): CanonicalMemoryDocument {
  return {
    id: row.id,
    profileId: row.profile_id,
    logicalKey: row.logical_key,
    contentMarkdown: row.content_markdown,
    documentRevision: row.document_revision,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function toSearchResult(row: Database["public"]["Functions"]["search_messages"]["Returns"][number]): MessageSearchResult {
  return {
    messageId: row.message_id,
    threadId: row.thread_id,
    profileId: row.profile_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    lexicalScore: row.lexical_score,
    semanticScore: row.semantic_score,
    combinedScore: row.combined_score,
  };
}

function toMessageContextItem(row: {
  id: string;
  thread_id: string;
  profile_id: "profile-a" | "profile-b";
  role: "user" | "assistant" | "tool";
  content: string;
  created_at: string;
}): MessageContextItem {
  return {
    messageId: row.id,
    threadId: row.thread_id,
    profileId: row.profile_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}

export function createSupabaseMemoryStore(database: MemoryDatabase = getDatabase()): MemoryStore & MessageSemanticIndexStore {
  return {
    async listDocuments(profileId) {
      assertMemoryProfileId(profileId);
      const { data, error } = await database
        .from("memory_documents")
        .select("id, profile_id, logical_key, content_markdown, document_revision, content_hash, created_at, updated_at, archived_at")
        .eq("profile_id", profileId)
        .is("archived_at", null)
        .order("logical_key", { ascending: true });
      if (error) throw error;
      return (data ?? []).map((row) => toDocument(row));
    },

    async getDocument(profileId, logicalKey) {
      assertMemoryProfileId(profileId);
      const validatedLogicalKey = validateLogicalKey(logicalKey);
      const { data, error } = await database
        .from("memory_documents")
        .select("id, profile_id, logical_key, content_markdown, document_revision, content_hash, created_at, updated_at, archived_at")
        .eq("profile_id", profileId)
        .eq("logical_key", validatedLogicalKey)
        .is("archived_at", null)
        .maybeSingle();
      if (error) throw error;
      return data ? toDocument(data) : null;
    },

    async getCurrentRevision(profileId) {
      assertMemoryProfileId(profileId);
      const { data, error } = await database
        .from("profile_memory_state")
        .select("current_revision")
        .eq("profile_id", profileId)
        .maybeSingle();
      if (error) throw error;
      return data?.current_revision ?? 0;
    },

    async applyDocumentRevision(input) {
      const validated = validateApplyMemoryDocumentRevision(input);
      const source = validated.provenance ?? ({ sourceKind: "manual" } satisfies MemoryProvenanceInput);
      const { data, error } = await database.rpc("apply_memory_document_revision", {
        p_profile_id: validated.profileId,
        p_logical_key: validated.logicalKey,
        p_content_markdown: validated.contentMarkdown,
        p_mutation_kind: validated.mutationKind,
        p_expected_document_revision: validated.expectedDocumentRevision ?? null,
        p_source_kind: source.sourceKind,
        p_source_thread_id: source.sourceThreadId ?? null,
        p_source_message_id: source.sourceMessageId ?? null,
        p_source_agent_event_id: source.sourceAgentEventId ?? null,
        p_source_agent_run_id: source.sourceAgentRunId ?? null,
        p_source_excerpt: source.sourceExcerpt ?? null,
        p_source_metadata: (source.metadata ?? {}) as Json,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new Error("Memory revision RPC returned no result.");
      return {
        profileId: row.profile_id,
        documentId: row.document_id,
        documentRevision: row.document_revision,
        profileGlobalRevision: row.profile_global_revision,
        revisionId: row.revision_id,
        provenanceId: row.provenance_id,
      } satisfies AppliedMemoryDocumentRevision;
    },

    async searchMessages(input) {
      assertMemoryProfileId(input.profileId);
      const { data, error } = await database.rpc("search_messages", {
        p_profile_id: input.profileId,
        p_query: input.query,
        p_query_embedding: input.queryEmbedding ? [...validateEmbedding(input.queryEmbedding)] : null,
        p_thread_id: input.threadId ?? null,
        p_from: input.from ?? null,
        p_to: input.to ?? null,
        p_limit: input.limit ?? 20,
      });
      if (error) throw error;
      return (data ?? []).map(toSearchResult);
    },

    async readMessageContext(profileId, messageId, windowSize = 3) {
      assertMemoryProfileId(profileId);
      validateMemoryUuid(messageId, "Message ID");
      const boundedWindow = normalizeMemoryLimit(windowSize, 3);
      const messageColumns = "id, thread_id, profile_id, role, content, created_at";
      const { data: target, error: targetError } = await database
        .from("messages")
        .select(messageColumns)
        .eq("id", messageId)
        .eq("profile_id", profileId)
        .maybeSingle();
      if (targetError) throw targetError;
      if (!target) return null;

      const { data: thread, error: threadError } = await database
        .from("threads")
        .select("id, profile_id, title, created_at, updated_at")
        .eq("id", target.thread_id)
        .eq("profile_id", profileId)
        .maybeSingle();
      if (threadError) throw threadError;
      if (!thread) return null;

      const beforePromise = database
        .from("messages")
        .select(messageColumns)
        .eq("thread_id", target.thread_id)
        .eq("profile_id", profileId)
        .or(`created_at.lt.${target.created_at},and(created_at.eq.${target.created_at},id.lt.${target.id})`)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(boundedWindow);
      const afterPromise = database
        .from("messages")
        .select(messageColumns)
        .eq("thread_id", target.thread_id)
        .eq("profile_id", profileId)
        .or(`created_at.gt.${target.created_at},and(created_at.eq.${target.created_at},id.gt.${target.id})`)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(boundedWindow);
      const [{ data: before, error: beforeError }, { data: after, error: afterError }] = await Promise.all([beforePromise, afterPromise]);
      if (beforeError) throw beforeError;
      if (afterError) throw afterError;

      return {
        thread: {
          id: thread.id,
          profileId: thread.profile_id,
          title: thread.title,
          createdAt: thread.created_at,
          updatedAt: thread.updated_at,
        },
        target: toMessageContextItem(target),
        before: (before ?? []).reverse().map(toMessageContextItem),
        after: (after ?? []).map(toMessageContextItem),
      } satisfies MessageContextWindow;
    },

    async searchDocuments(profileId, rawQuery, rawLimit = 5) {
      assertMemoryProfileId(profileId);
      const query = normalizeMemoryQuery(rawQuery);
      const limit = normalizeMemoryLimit(rawLimit);
      const { data, error } = await database
        .from("memory_documents")
        .select("id, profile_id, logical_key, content_markdown, document_revision, content_hash, created_at, updated_at, archived_at")
        .eq("profile_id", profileId)
        .is("archived_at", null)
        .order("logical_key", { ascending: true });
      if (error) throw error;
      const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
      return (data ?? [])
        .map((document) => {
          const haystack = `${document.logical_key} ${document.content_markdown}`.toLocaleLowerCase();
          const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
          const compact = document.content_markdown.replace(/\s+/g, " ").trim();
          const matchAt = compact.toLocaleLowerCase().indexOf(terms[0] ?? "");
          const start = matchAt > 0 ? Math.max(0, matchAt - 70) : 0;
          const excerpt = compact.length <= 280 ? compact : `${start > 0 ? "…" : ""}${compact.slice(start, start + 278).trimEnd()}…`;
          return { document, score, excerpt };
        })
        .filter(({ score }) => score > 0)
        .sort((left, right) => right.score - left.score || left.document.logical_key.localeCompare(right.document.logical_key))
        .slice(0, limit)
        .map(({ document, excerpt }) => ({
          documentId: document.id,
          profileId: document.profile_id,
          logicalKey: document.logical_key,
          excerpt,
          documentRevision: document.document_revision,
          updatedAt: document.updated_at,
        } satisfies CanonicalDocumentSearchResult));
    },

    async getMessageEmbeddingMetadata(profileId, messageId) {
      assertMemoryProfileId(profileId);
      const { data, error } = await database
        .from("message_semantic_index")
        .select("message_id, profile_id, thread_id, content_hash, embedding_model, indexed_at")
        .eq("profile_id", profileId)
        .eq("message_id", messageId)
        .maybeSingle();
      if (error) throw error;
      return data ? {
        messageId: data.message_id,
        profileId: data.profile_id,
        threadId: data.thread_id,
        contentHash: data.content_hash,
        embeddingModel: data.embedding_model,
        indexedAt: data.indexed_at,
      } satisfies MessageEmbeddingMetadata : null;
    },

    async upsertMessageEmbedding(input) {
      assertMemoryProfileId(input.profileId);
      validateEmbedding(input.embedding);
      validateEmbeddingModel(input.embeddingModel ?? "");
      const { error } = await database
        .from("message_semantic_index")
        .upsert({
          message_id: input.messageId,
          profile_id: input.profileId,
          thread_id: input.threadId,
          embedding: [...input.embedding],
          embedding_model: input.embeddingModel,
          content_hash: input.contentHash,
          indexed_at: input.indexedAt,
        }, { onConflict: "message_id,profile_id,thread_id" });
      if (error) throw error;
    },
  };
}

export type { MemoryStore, MessageSemanticIndexStore };
