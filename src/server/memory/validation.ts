import { isProfileId, type ProfileId } from "@/lib/profiles";
import { MEMORY_EMBEDDING_DIMENSIONS, type ApplyMemoryItemRevisionInput, type MemoryProvenanceInput, type MemoryProvenanceRelation, type MessageMatchType, type MessageSearchRole } from "@/server/memory/types";

const CANONICAL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const MAX_CONTENT_LENGTH = 500_000;
const MAX_EXCERPT_LENGTH = 2_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 240;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVENANCE_RELATIONS: readonly MemoryProvenanceRelation[] = ["supports", "corrects", "supersedes", "contradicts", "derived"];

export type MemorySafetyRejectionCode =
  | "credential_or_secret"
  | "one_time_code"
  | "transient_mood"
  | "transient_location"
  | "role_play"
  | "speculative_psychology"
  | "third_party_sensitive_data";

export class MemorySafetyRejection extends Error {
  readonly code: MemorySafetyRejectionCode;

  constructor(code: MemorySafetyRejectionCode, message: string) {
    super(message);
    this.name = "MemorySafetyRejection";
    this.code = code;
  }
}

export function assertMemoryProfileId(value: unknown): asserts value is ProfileId {
  if (!isProfileId(value)) throw new Error("A valid profile scope is required.");
}

export function validateCanonicalKey(value: string) {
  const canonicalKey = value.trim();
  if (!canonicalKey || canonicalKey.length > 200 || !CANONICAL_KEY_PATTERN.test(canonicalKey)) {
    throw new Error("Memory canonical keys must be short safe identifiers.");
  }
  return canonicalKey;
}

export function validateMemoryContent(value: string) {
  if (!value || value.length > MAX_CONTENT_LENGTH || value.includes("\u0000")) {
    throw new Error("Memory content must be non-empty natural language.");
  }
  return value;
}

/**
 * Candidate extraction is deliberately conservative. This is a runtime
 * safety gate, not a classifier: a candidate that looks like a secret or a
 * fleeting observation is rejected instead of being guessed into durable
 * memory. Explicit user writes pass through the same gate.
 */
export function validateMemoryContentSafety(value: string): string {
  const content = value.trim();
  const compact = content.replace(/\s+/g, " ");
  const lower = compact.toLocaleLowerCase();

  const secretPatterns: Array<RegExp> = [
    /-----begin [^-]+private key-----/i,
    /\b(?:sk-[a-z0-9]{16,}|sk_(?:live|test)_[a-z0-9]{12,}|ghp_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{16,}|AIza[0-9a-z_-]{20,})\b/i,
    /\b(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|private[ _-]?key|password|passwd|secret)\s*[:=]\s*\S+/i,
    /\b(?:my|the)\s+(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|private[ _-]?key|password|passwd|secret)\b/i,
    /\bauthorization\s*:\s*bearer\s+\S+/i,
  ];
  if (secretPatterns.some((pattern) => pattern.test(compact))) {
    throw new MemorySafetyRejection("credential_or_secret", "Credentials and secrets cannot be saved to memory.");
  }

  if (/(?:one[- ]time|verification|authentication|2fa|two[- ]factor|security)\s+(?:code|passcode|otp)\b/i.test(lower)) {
    throw new MemorySafetyRejection("one_time_code", "One-time codes cannot be saved to memory.");
  }

  const transientMood = /\b(?:today|right now|currently|at the moment|this morning|tonight)\b[\s\S]{0,80}\b(?:feel|feeling|mood|sad|happy|angry|anxious|tired|stressed|excited|overwhelmed|depressed)\b/i.test(compact)
    || /\b(?:feel|feeling|mood)\b[\s\S]{0,60}\b(?:today|right now|currently|at the moment)\b/i.test(compact);
  if (transientMood) {
    throw new MemorySafetyRejection("transient_mood", "Transient moods are not durable memory.");
  }

  if (/\b(?:i am|i'm|currently|right now)\s+(?:at|in|near|inside|outside|on my way to)\b/i.test(compact)
    || /\bcurrently located\b/i.test(lower)) {
    throw new MemorySafetyRejection("transient_location", "Transient locations are not durable memory.");
  }

  if (/\b(?:role[- ]?play|pretend|fictional|in this scenario|as a character|let's imagine)\b/i.test(compact)) {
    throw new MemorySafetyRejection("role_play", "Role-play content is not saved as personal memory.");
  }

  if (/(?:maybe|perhaps|probably|might be|could be|seems like|sounds like|i suspect|you seem)\b[\s\S]{0,80}\b(?:adhd|autistic|autism|bipolar|depressed|anxious|narcissist|ocd|personality disorder|mental illness|diagnos)/i.test(compact)
    || /\b(?:you are|you're|i am|i'm)\s+(?:a |an )?(?:narcissist|sociopath|psychopath|mentally ill)\b/i.test(compact)) {
    throw new MemorySafetyRejection("speculative_psychology", "Speculative diagnoses and psychological labels cannot be saved as memory.");
  }

  if (/\b(?:my friend|my colleague|my coworker|my neighbor|someone|a third party)\b[\s\S]{0,100}\b(?:phone|email|address|ssn|social security|bank|account number|medical|health|diagnos|passport|date of birth)\b/i.test(compact)
    || /\b[A-Z][a-z]{2,}\b[\s\S]{0,60}\b(?:phone|email|address|ssn|social security|bank|account number|medical|health|diagnos|passport|date of birth)\b/.test(compact)) {
    throw new MemorySafetyRejection("third_party_sensitive_data", "Sensitive third-party data cannot be saved to memory.");
  }

  return content;
}

export function validateProvenance(provenance: MemoryProvenanceInput | undefined) {
  const source = provenance ?? { sourceKind: "manual" as const };
  const relation = source.relation ?? "supports";
  if (!PROVENANCE_RELATIONS.includes(relation)) throw new Error("Memory provenance relation is invalid.");
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
  return source.relation ? { ...source, relation } : source;
}

export function validateApplyMemoryItemRevision(input: ApplyMemoryItemRevisionInput) {
  assertMemoryProfileId(input.profileId);
  const canonicalKey = validateCanonicalKey(input.canonicalKey);
  const content = validateMemoryContent(input.content);
  validateMemoryContentSafety(content);
  if (input.expectedItemRevision !== undefined && input.expectedItemRevision !== null && (!Number.isSafeInteger(input.expectedItemRevision) || input.expectedItemRevision < 0)) {
    throw new Error("Expected memory item revision must be a non-negative integer.");
  }
  const idempotencyKey = input.idempotencyKey === undefined || input.idempotencyKey === null ? null : input.idempotencyKey.trim();
  if (idempotencyKey !== null && (!idempotencyKey || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH)) {
    throw new Error("Memory idempotency keys must be short and non-empty.");
  }
  validateProvenance(input.provenance);
  if (input.supersededByItemId !== undefined && input.supersededByItemId !== null) validateMemoryUuid(input.supersededByItemId, "Superseded memory item ID");
  if (input.confidence !== undefined && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) throw new Error("Memory confidence must be between 0 and 1.");
  if (input.importance !== undefined && (!Number.isFinite(input.importance) || input.importance < 0 || input.importance > 1)) throw new Error("Memory importance must be between 0 and 1.");
  return { ...input, canonicalKey, content, idempotencyKey };
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

export function normalizeMemoryExactPhrase(value: string | null | undefined) {
  if (value === null || value === undefined) return null;
  const phrase = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!phrase || phrase.length > 500) throw new Error("Exact historical phrases must be between 1 and 500 characters.");
  return phrase;
}

export function normalizeMemoryMatchType(value: MessageMatchType | undefined): MessageMatchType {
  return value === "exact_phrase" || value === "semantic" ? value : "hybrid";
}

export function normalizeMemoryRoles(value: readonly MessageSearchRole[] | null | undefined): MessageSearchRole[] | null {
  if (value === null || value === undefined) return null;
  const roles = [...new Set(value)];
  if (roles.length === 0 || roles.some((role) => role !== "user" && role !== "assistant" && role !== "tool")) {
    throw new Error("Historical search roles must be user, assistant, or tool.");
  }
  return roles;
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
