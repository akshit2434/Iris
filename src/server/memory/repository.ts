import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getDatabase } from "@/server/db/client";
import type { Database, Json } from "@/server/db/types";
import {
  type AppliedMemoryItemRevision,
  type MemoryItem,
  type MemoryItemAudit,
  type MemoryItemSearchResult,
  type MemoryItemRevision,
  type MemoryProvenanceInput,
  type MemorySource,
  type MessageContextItem,
  type MessageContextWindow,
  type MessageEmbeddingMetadata,
  type MessageSearchResult,
  type MemoryStore,
  type MessageSemanticIndexStore,
  type ApplyMemoryItemRevisionInput,
  type MemoryProvenanceRelation,
  type MemorySuppression,
} from "@/server/memory/types";
import {
  assertMemoryProfileId,
  normalizeMemoryLimit,
  normalizeMemoryQuery,
  validateApplyMemoryItemRevision,
  validateCanonicalKey,
  validateEmbedding,
  validateEmbeddingModel,
  validateMemoryUuid,
} from "@/server/memory/validation";

type MemoryDatabase = SupabaseClient<Database>;

type MemoryItemRow = Database["public"]["Tables"]["memory_items"]["Row"];
type MemoryItemRevisionRow = Database["public"]["Tables"]["memory_item_revisions"]["Row"];

function toItem(row: MemoryItemRow): MemoryItem {
  return {
    id: row.id,
    profileId: row.profile_id,
    canonicalKey: row.canonical_key,
    content: row.content,
    itemRevision: row.item_revision,
    category: row.category,
    valueScope: row.value_scope,
    origin: row.origin,
    confidence: row.confidence,
    importance: row.importance,
    sensitivity: row.sensitivity,
    status: row.status,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    lastConfirmedAt: row.last_confirmed_at,
    supersededByItemId: row.superseded_by_item_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    deletedAt: row.deleted_at,
  };
}

function toRevision(row: MemoryItemRevisionRow): MemoryItemRevision {
  return {
    id: row.id,
    profileId: row.profile_id,
    itemId: row.item_id,
    itemRevision: row.item_revision,
    profileGlobalRevision: row.profile_global_revision,
    canonicalKey: row.canonical_key,
    content: row.content,
    contentHash: row.content_hash,
    category: row.category,
    valueScope: row.value_scope,
    origin: row.origin,
    confidence: row.confidence,
    importance: row.importance,
    sensitivity: row.sensitivity,
    status: row.status,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    lastConfirmedAt: row.last_confirmed_at,
    supersededByItemId: row.superseded_by_item_id,
    mutationKind: row.mutation_kind,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
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

function toAdvancedSearchResult(row: Database["public"]["Functions"]["search_messages_v2"]["Returns"][number]): MessageSearchResult {
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
    matchType: row.match_type === "exact_phrase" || row.match_type === "semantic" ? row.match_type : "hybrid",
  };
}

function toMessageContextItem(row: { id: string; thread_id: string; profile_id: "profile-a" | "profile-b"; role: "user" | "assistant" | "tool"; content: string; created_at: string }): MessageContextItem {
  return { messageId: row.id, threadId: row.thread_id, profileId: row.profile_id, role: row.role, content: row.content, createdAt: row.created_at };
}

function compactExcerpt(value: string, max = 280) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1).trimEnd()}…` : compact;
}

const provenanceRelations: readonly MemoryProvenanceRelation[] = ["supports", "corrects", "supersedes", "contradicts", "derived"];

function readProvenanceRelation(metadata: Record<string, unknown>): MemoryProvenanceRelation {
  return typeof metadata.relation === "string" && provenanceRelations.includes(metadata.relation as MemoryProvenanceRelation)
    ? metadata.relation as MemoryProvenanceRelation
    : "supports";
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEMORY_SEARCH_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have", "i", "in", "is", "it", "me", "my", "of", "on", "or", "that", "the", "this", "to", "user", "was", "with", "you", "your",
]);

function memorySearchTokens(value: string) {
  return value.toLocaleLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 2 && !MEMORY_SEARCH_STOP_WORDS.has(token));
}

function statusFilter(options: { includeArchived?: boolean; includeDeleted?: boolean }) {
  if (options.includeDeleted) return ["active", "superseded", "archived", "deleted"] as const;
  if (options.includeArchived) return ["active", "superseded", "archived"] as const;
  return ["active"] as const;
}

export function createSupabaseMemoryStore(database: MemoryDatabase = getDatabase()): MemoryStore & MessageSemanticIndexStore {
  return {
    async listItems(profileId, options = {}) {
      assertMemoryProfileId(profileId);
      const { data, error } = await database
        .from("memory_items")
        .select("id, profile_id, canonical_key, content, item_revision, category, value_scope, origin, confidence, importance, sensitivity, status, valid_from, valid_until, last_confirmed_at, superseded_by_item_id, created_at, updated_at, archived_at, deleted_at")
        .eq("profile_id", profileId)
        .in("status", [...statusFilter(options)])
        .order("canonical_key", { ascending: true })
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return (data ?? []).map(toItem);
    },

    async getItem(profileId, canonicalKey, options = {}) {
      assertMemoryProfileId(profileId);
      const validatedKey = validateCanonicalKey(canonicalKey);
      const { data, error } = await database
        .from("memory_items")
        .select("id, profile_id, canonical_key, content, item_revision, category, value_scope, origin, confidence, importance, sensitivity, status, valid_from, valid_until, last_confirmed_at, superseded_by_item_id, created_at, updated_at, archived_at, deleted_at")
        .eq("profile_id", profileId)
        .eq("canonical_key", validatedKey)
        .in("status", [...statusFilter(options)])
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data ? toItem(data) : null;
    },

    async getCurrentRevision(profileId) {
      assertMemoryProfileId(profileId);
      const { data, error } = await database.from("profile_memory_state").select("current_revision").eq("profile_id", profileId).maybeSingle();
      if (error) throw error;
      return data?.current_revision ?? 0;
    },

    async applyItemRevision(input: ApplyMemoryItemRevisionInput) {
      const validated = validateApplyMemoryItemRevision(input);
      const source = validated.provenance ?? ({ sourceKind: "manual" } satisfies MemoryProvenanceInput);
      const sourceMetadata = {
        ...(source.metadata ?? {}),
        relation: source.relation ?? "supports",
      } as Json;
      const { data, error } = await database.rpc("apply_memory_item_revision", {
        p_profile_id: validated.profileId,
        p_canonical_key: validated.canonicalKey,
        p_content: validated.content,
        p_category: validated.category ?? "other",
        p_value_scope: validated.valueScope ?? "single",
        p_origin: validated.origin ?? "inferred",
        p_confidence: validated.confidence ?? 0.5,
        p_importance: validated.importance ?? 0.5,
        p_sensitivity: validated.sensitivity ?? "normal",
        p_status: validated.status,
        p_mutation_kind: validated.mutationKind,
        p_expected_item_revision: validated.expectedItemRevision ?? null,
        p_source_kind: source.sourceKind,
        p_source_thread_id: source.sourceThreadId ?? null,
        p_source_message_id: source.sourceMessageId ?? null,
        p_source_agent_event_id: source.sourceAgentEventId ?? null,
        p_source_agent_run_id: source.sourceAgentRunId ?? null,
        p_source_excerpt: source.sourceExcerpt ?? null,
        p_source_metadata: sourceMetadata,
        p_idempotency_key: validated.idempotencyKey ?? null,
        p_superseded_by_item_id: validated.supersededByItemId ?? null,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new Error("Memory item revision RPC returned no result.");
      return {
        profileId: row.profile_id,
        itemId: row.item_id,
        canonicalKey: row.canonical_key,
        itemRevision: row.item_revision,
        profileGlobalRevision: row.profile_global_revision,
        revisionId: row.revision_id,
        sourceId: row.source_id,
        contentHash: row.content_hash,
      } satisfies AppliedMemoryItemRevision;
    },

    async searchMessages(input) {
      assertMemoryProfileId(input.profileId);
      const advanced = input.matchType !== undefined || input.exactPhrase !== undefined || input.roles !== undefined;
      const { data, error } = advanced
        ? await database.rpc("search_messages_v2", {
            p_profile_id: input.profileId,
            p_query: input.query,
            p_exact_phrase: input.exactPhrase ?? null,
            p_match_type: input.matchType ?? "hybrid",
            p_roles: input.roles ? [...input.roles] : null,
            p_query_embedding: input.queryEmbedding ? [...validateEmbedding(input.queryEmbedding)] : null,
            p_thread_id: input.threadId ?? null,
            p_from: input.from ?? null,
            p_to: input.to ?? null,
            p_limit: input.limit ?? 20,
          })
        : await database.rpc("search_messages", {
            p_profile_id: input.profileId,
            p_query: input.query,
            p_query_embedding: input.queryEmbedding ? [...validateEmbedding(input.queryEmbedding)] : null,
            p_thread_id: input.threadId ?? null,
            p_from: input.from ?? null,
            p_to: input.to ?? null,
            p_limit: input.limit ?? 20,
      });
      if (error) throw error;
      if (advanced) {
        const rows = (data ?? []) as Database["public"]["Functions"]["search_messages_v2"]["Returns"];
        return rows.map(toAdvancedSearchResult);
      }
      const rows = (data ?? []) as Database["public"]["Functions"]["search_messages"]["Returns"];
      return rows.map(toSearchResult);
    },

    async readMessageContext(profileId, messageId, windowSize = 3) {
      assertMemoryProfileId(profileId);
      validateMemoryUuid(messageId, "Message ID");
      const boundedWindow = normalizeMemoryLimit(windowSize, 3);
      const messageColumns = "id, thread_id, profile_id, role, content, created_at";
      const { data: target, error: targetError } = await database.from("messages").select(messageColumns).eq("id", messageId).eq("profile_id", profileId).maybeSingle();
      if (targetError) throw targetError;
      if (!target) return null;
      const { data: thread, error: threadError } = await database.from("threads").select("id, profile_id, title, created_at, updated_at").eq("id", target.thread_id).eq("profile_id", profileId).maybeSingle();
      if (threadError) throw threadError;
      if (!thread) return null;
      const beforePromise = database.from("messages").select(messageColumns).eq("thread_id", target.thread_id).eq("profile_id", profileId).or(`created_at.lt.${target.created_at},and(created_at.eq.${target.created_at},id.lt.${target.id})`).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(boundedWindow);
      const afterPromise = database.from("messages").select(messageColumns).eq("thread_id", target.thread_id).eq("profile_id", profileId).or(`created_at.gt.${target.created_at},and(created_at.eq.${target.created_at},id.gt.${target.id})`).order("created_at", { ascending: true }).order("id", { ascending: true }).limit(boundedWindow);
      const [{ data: before, error: beforeError }, { data: after, error: afterError }] = await Promise.all([beforePromise, afterPromise]);
      if (beforeError) throw beforeError;
      if (afterError) throw afterError;
      return {
        thread: { id: thread.id, profileId: thread.profile_id, title: thread.title, createdAt: thread.created_at, updatedAt: thread.updated_at },
        target: toMessageContextItem(target), before: (before ?? []).reverse().map(toMessageContextItem), after: (after ?? []).map(toMessageContextItem),
      } satisfies MessageContextWindow;
    },

    async searchItems(profileId, rawQuery, rawLimit = 5, options = {}) {
      assertMemoryProfileId(profileId);
      const query = normalizeMemoryQuery(rawQuery);
      const limit = normalizeMemoryLimit(rawLimit);
      const { data, error } = await database
        .from("memory_items")
        .select("id, profile_id, canonical_key, content, item_revision, category, value_scope, origin, confidence, importance, sensitivity, status, valid_from, valid_until, last_confirmed_at, superseded_by_item_id, created_at, updated_at, archived_at, deleted_at")
        .eq("profile_id", profileId)
        .in("status", [...statusFilter(options)])
        .order("updated_at", { ascending: false });
      if (error) throw error;
      const terms = memorySearchTokens(query);
      if (terms.length === 0) return [];
      return (data ?? [])
        .map((item) => {
          const haystack = `${item.canonical_key} ${item.content} ${item.category}`.toLocaleLowerCase();
          const haystackTokens = new Set(memorySearchTokens(haystack));
          const score = terms.reduce((total, term) => total + (haystackTokens.has(term) ? 1 : 0), 0);
          const compact = item.content.replace(/\s+/g, " ").trim();
          const matchAt = compact.toLocaleLowerCase().indexOf(terms[0] ?? "");
          const start = matchAt > 0 ? Math.max(0, matchAt - 70) : 0;
          const excerpt = compact.length <= 280 ? compact : `${start > 0 ? "…" : ""}${compact.slice(start, start + 278).trimEnd()}…`;
          return { item, score, excerpt };
        })
        .filter(({ score }) => score > 0)
        .sort((left, right) => right.score - left.score || right.item.updated_at.localeCompare(left.item.updated_at) || left.item.canonical_key.localeCompare(right.item.canonical_key))
        .slice(0, limit)
        .map(({ item, excerpt }) => ({ itemId: item.id, profileId: item.profile_id, canonicalKey: item.canonical_key, excerpt, itemRevision: item.item_revision, updatedAt: item.updated_at, category: item.category, status: item.status } satisfies MemoryItemSearchResult));
    },

    async listMemoryChanges(profileId, afterRevision, throughRevision, rawLimit = 20) {
      assertMemoryProfileId(profileId);
      if (!Number.isSafeInteger(afterRevision) || afterRevision < 0 || !Number.isSafeInteger(throughRevision) || throughRevision < afterRevision) return [];
      const limit = normalizeMemoryLimit(rawLimit, 20);
      const { data, error } = await database.from("memory_item_revisions")
        .select("id, profile_id, item_id, item_revision, profile_global_revision, canonical_key, content, content_hash, category, value_scope, origin, confidence, importance, sensitivity, status, valid_from, valid_until, last_confirmed_at, superseded_by_item_id, mutation_kind, idempotency_key, created_at")
        .eq("profile_id", profileId).gt("profile_global_revision", afterRevision).lte("profile_global_revision", throughRevision)
        .order("profile_global_revision", { ascending: true }).limit(Math.min(limit * 8, 100));
      if (error) throw error;
      const latest = new Map<string, MemoryItemRevisionRow>();
      for (const row of data ?? []) latest.set(row.canonical_key, row);
      return [...latest.entries()]
        .sort((left, right) => left[1].profile_global_revision - right[1].profile_global_revision || left[0].localeCompare(right[0]))
        .slice(0, limit)
        .map(([canonicalKey, row]) => ({ canonicalKey, mutationKind: row.mutation_kind, itemRevision: row.item_revision, profileGlobalRevision: row.profile_global_revision, createdAt: row.created_at, status: row.status, content: row.content, excerpt: compactExcerpt(row.content) }));
    },

    async getItemAudit(profileId, canonicalKey) {
      assertMemoryProfileId(profileId);
      const validatedKey = validateCanonicalKey(canonicalKey);
      const { data: item, error: itemError } = await database.from("memory_items").select("id, profile_id, canonical_key, content, item_revision, category, value_scope, origin, confidence, importance, sensitivity, status, valid_from, valid_until, last_confirmed_at, superseded_by_item_id, created_at, updated_at, archived_at, deleted_at").eq("profile_id", profileId).eq("canonical_key", validatedKey).order("updated_at", { ascending: false }).limit(1).maybeSingle();
      if (itemError) throw itemError;
      if (!item) return null;
      const { data: revisions, error: revisionError } = await database.from("memory_item_revisions").select("id, profile_id, item_id, item_revision, profile_global_revision, canonical_key, content, content_hash, category, value_scope, origin, confidence, importance, sensitivity, status, valid_from, valid_until, last_confirmed_at, superseded_by_item_id, mutation_kind, idempotency_key, created_at").eq("profile_id", profileId).eq("item_id", item.id).order("item_revision", { ascending: false });
      if (revisionError) throw revisionError;
      const revisionIds = (revisions ?? []).map((revision) => revision.id);
      const { data: sources, error: sourceError } = revisionIds.length === 0 ? { data: [], error: null } : await database.from("memory_item_sources").select("id, profile_id, item_id, revision_id, source_kind, source_thread_id, source_message_id, source_agent_event_id, source_agent_run_id, source_excerpt, metadata, created_at").eq("profile_id", profileId).in("revision_id", revisionIds).order("created_at", { ascending: true });
      if (sourceError) throw sourceError;
      const sourcesByRevision = new Map<string, MemorySource[]>();
      for (const source of sources ?? []) {
        const action = source.source_thread_id && source.source_message_id && UUID_PATTERN.test(source.source_thread_id) && UUID_PATTERN.test(source.source_message_id) ? { type: "open_message" as const, threadId: source.source_thread_id, messageId: source.source_message_id, label: "Open source" } : undefined;
        const metadata = (source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata) ? source.metadata : {}) as Record<string, unknown>;
        const record: MemorySource = { id: source.id, sourceKind: source.source_kind, sourceThreadId: source.source_thread_id, sourceMessageId: source.source_message_id, sourceAgentEventId: source.source_agent_event_id, sourceAgentRunId: source.source_agent_run_id, sourceExcerpt: source.source_excerpt, metadata, relation: readProvenanceRelation(metadata), createdAt: source.created_at, ...(action ? { action } : {}) };
        sourcesByRevision.set(source.revision_id, [...(sourcesByRevision.get(source.revision_id) ?? []), record]);
      }
      return {
        item: toItem(item),
        revisions: (revisions ?? []).map((revision) => ({ ...toRevision(revision), sources: sourcesByRevision.get(revision.id) ?? [] })),
      } satisfies MemoryItemAudit;
    },

    async isSuppressed(profileId, canonicalKey, contentHash = null) {
      assertMemoryProfileId(profileId);
      const validatedKey = validateCanonicalKey(canonicalKey);
      let query = database.from("memory_suppressions").select("id").eq("profile_id", profileId).eq("canonical_key", validatedKey).is("lifted_at", null).limit(1);
      if (contentHash) query = query.or(`content_hash.is.null,content_hash.eq.${contentHash}`);
      const { data, error } = await query.maybeSingle();
      if (error) throw error;
      return Boolean(data);
    },

    async listActiveSuppressions(profileId) {
      assertMemoryProfileId(profileId);
      const { data, error } = await database
        .from("memory_suppressions")
        .select("id, profile_id, canonical_key, content_hash, item_id, reason, created_at, lifted_at")
        .eq("profile_id", profileId)
        .is("lifted_at", null)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []).map((row) => ({
        id: row.id,
        profileId: row.profile_id,
        canonicalKey: row.canonical_key,
        contentHash: row.content_hash,
        itemId: row.item_id,
        reason: row.reason,
        createdAt: row.created_at,
        liftedAt: row.lifted_at,
      } satisfies MemorySuppression));
    },

    async createSuppression(input) {
      assertMemoryProfileId(input.profileId);
      const { data, error } = await database.rpc("create_memory_suppression", { p_profile_id: input.profileId, p_canonical_key: validateCanonicalKey(input.canonicalKey), p_content_hash: input.contentHash ?? null, p_item_id: input.itemId ?? null, ...(input.reason ? { p_reason: input.reason } : {}) });
      if (error) throw error;
      if (typeof data !== "string") throw new Error("Memory suppression returned no ID.");
      return data;
    },

    async liftSuppression(profileId, canonicalKey, contentHash = null) {
      assertMemoryProfileId(profileId);
      const { data, error } = await database.rpc("lift_memory_suppression", { p_profile_id: profileId, p_canonical_key: validateCanonicalKey(canonicalKey), p_content_hash: contentHash });
      if (error) throw error;
      return typeof data === "number" ? data : Number(data ?? 0);
    },

    async advanceThreadMemoryRevisionSeen(profileId, threadId, snapshotRevision) {
      assertMemoryProfileId(profileId);
      validateMemoryUuid(threadId, "Thread ID");
      if (!Number.isSafeInteger(snapshotRevision) || snapshotRevision < 0) throw new Error("Invalid memory revision snapshot.");
      const { data, error } = await database.rpc("advance_thread_memory_revision_seen", { p_profile_id: profileId, p_thread_id: threadId, p_snapshot_revision: snapshotRevision });
      if (error) throw error;
      return typeof data === "number" ? data : Number(data ?? 0);
    },

    async getMessageEmbeddingMetadata(profileId, messageId) {
      assertMemoryProfileId(profileId);
      const { data, error } = await database.from("message_semantic_index").select("message_id, profile_id, thread_id, content_hash, embedding_model, indexed_at").eq("profile_id", profileId).eq("message_id", messageId).maybeSingle();
      if (error) throw error;
      return data ? { messageId: data.message_id, profileId: data.profile_id, threadId: data.thread_id, contentHash: data.content_hash, embeddingModel: data.embedding_model, indexedAt: data.indexed_at } satisfies MessageEmbeddingMetadata : null;
    },

    async upsertMessageEmbedding(input) {
      assertMemoryProfileId(input.profileId);
      validateEmbedding(input.embedding);
      validateEmbeddingModel(input.embeddingModel ?? "");
      const { error } = await database.from("message_semantic_index").upsert({ message_id: input.messageId, profile_id: input.profileId, thread_id: input.threadId, embedding: [...input.embedding], embedding_model: input.embeddingModel, content_hash: input.contentHash, indexed_at: input.indexedAt }, { onConflict: "message_id,profile_id,thread_id" });
      if (error) throw error;
    },
  };
}

export type { MemoryStore, MessageSemanticIndexStore };
