import { isProfileId, type ProfileId } from "@/lib/profiles";
import { MEMORY_EMBEDDING_DIMENSIONS, type ApplyMemoryDocumentRevisionInput, type MemoryProvenanceInput } from "@/server/memory/types";

const LOGICAL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MAX_MARKDOWN_LENGTH = 500_000;
const MAX_EXCERPT_LENGTH = 2_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertMemoryProfileId(value: unknown): asserts value is ProfileId {
  if (!isProfileId(value)) throw new Error("A valid profile scope is required.");
}

export function validateLogicalKey(value: string) {
  const logicalKey = value.trim();
  if (!logicalKey || logicalKey.length > 200 || !LOGICAL_KEY_PATTERN.test(logicalKey)) {
    throw new Error("Canonical memory logical keys must be short safe paths.");
  }
  return logicalKey;
}

export function validateCanonicalMarkdown(value: string) {
  if (!value || value.length > MAX_MARKDOWN_LENGTH || value.includes("\u0000")) {
    throw new Error("Canonical memory content must be non-empty natural Markdown.");
  }
  return value;
}

export function validateProvenance(provenance: MemoryProvenanceInput | undefined) {
  const source = provenance ?? { sourceKind: "manual" as const };
  if (source.sourceKind === "message" && (!source.sourceMessageId || !source.sourceThreadId)) {
    throw new Error("Message provenance requires message and thread ownership.");
  }
  if (source.sourceKind === "thread" && !source.sourceThreadId) {
    throw new Error("Thread provenance requires thread ownership.");
  }
  if (source.sourceKind === "agent_event" && (!source.sourceAgentEventId || !source.sourceAgentRunId || !source.sourceThreadId)) {
    throw new Error("Agent-event provenance requires event, run, and thread ownership.");
  }
  if ((source.sourceKind === "manual" || source.sourceKind === "system") && (source.sourceMessageId || source.sourceAgentEventId)) {
    throw new Error("Manual/system provenance cannot claim a message or event.");
  }
  if (source.sourceExcerpt && source.sourceExcerpt.length > MAX_EXCERPT_LENGTH) {
    throw new Error("Memory provenance excerpts are limited to 2,000 characters.");
  }
  return source;
}

export function validateApplyMemoryDocumentRevision(input: ApplyMemoryDocumentRevisionInput) {
  assertMemoryProfileId(input.profileId);
  const logicalKey = validateLogicalKey(input.logicalKey);
  const contentMarkdown = validateCanonicalMarkdown(input.contentMarkdown);
  if (input.expectedDocumentRevision !== undefined && input.expectedDocumentRevision !== null && (!Number.isSafeInteger(input.expectedDocumentRevision) || input.expectedDocumentRevision < 0)) {
    throw new Error("Expected memory document revision must be a non-negative integer.");
  }
  validateProvenance(input.provenance);
  return { ...input, logicalKey, contentMarkdown };
}

export function validateEmbedding(vector: readonly number[]) {
  if (vector.length !== MEMORY_EMBEDDING_DIMENSIONS || vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`Embeddings must contain exactly ${MEMORY_EMBEDDING_DIMENSIONS} finite numbers.`);
  }
  return vector;
}

export function validateEmbeddingModel(model: string) {
  const normalized = model.trim();
  if (!normalized || normalized.length > 200) throw new Error("A valid embedding model is required.");
  return normalized;
}

export function isMemoryUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function validateMemoryUuid(value: string, label = "ID") {
  if (!isMemoryUuid(value)) throw new Error(`${label} must be a valid UUID.`);
  return value;
}

export function normalizeMemoryQuery(value: string) {
  const query = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!query || query.length > 500) throw new Error("Memory search queries must be between 1 and 500 characters.");
  return query;
}

export function normalizeMemoryLimit(value: number | undefined, fallback = 5) {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Memory search limits must be positive integers.");
  return Math.min(limit, 10);
}

export function normalizeMemoryDate(value: string | null | undefined, label: string) {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error(`${label} must be a valid date.`);
  return date.toISOString();
}
