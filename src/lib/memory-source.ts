import type { SafeToolJson } from "@/lib/types";
import { isProfileId, type ProfileId } from "@/lib/profiles";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_LABEL_LENGTH = 80;
const MAX_EXCERPT_LENGTH = 280;

export type OpenMessageAction = {
  type: "open_message";
  threadId: string;
  messageId: string;
  label: string;
};

export type MemorySourceRow = {
  action: OpenMessageAction;
  profileId: ProfileId;
  excerpt: string;
  createdAt: string;
  role?: "user" | "assistant" | "tool";
  threadTitle?: string;
};

export type CanonicalMemoryRow = {
  logicalKey: string;
  excerpt: string;
  documentRevision: number;
  updatedAt: string;
};

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function boundedText(value: unknown, max: number) {
  if (typeof value !== "string") return null;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  return compact.length > max ? `${compact.slice(0, max - 1).trimEnd()}…` : compact;
}

export function validateOpenMessageAction(value: unknown): OpenMessageAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "open_message" || !isUuid(candidate.threadId) || !isUuid(candidate.messageId)) return null;
  const label = boundedText(candidate.label, MAX_LABEL_LENGTH);
  if (!label || /^(?:https?:|javascript:|data:)/i.test(label)) return null;
  return { type: "open_message", threadId: candidate.threadId, messageId: candidate.messageId, label };
}

/** Build a safe internal source action from IDs owned by a validated result. */
export function buildOpenMessageAction(threadId: unknown, messageId: unknown, label = "Open source") {
  return validateOpenMessageAction({ type: "open_message", threadId, messageId, label });
}

export function buildOpenMessageHref(action: Pick<OpenMessageAction, "threadId" | "messageId">) {
  if (!isUuid(action.threadId) || !isUuid(action.messageId)) return null;
  return `/chat/${action.threadId}#message-${action.messageId}`;
}

function objectOutput(value: SafeToolJson | undefined): Record<string, SafeToolJson> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, SafeToolJson>;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, SafeToolJson> : null;
  } catch {
    return null;
  }
}

function getRows(value: SafeToolJson | undefined) {
  const output = objectOutput(value);
  return output && Array.isArray(output.results) ? output.results : [];
}

function sourceRow(value: unknown, expectedProfileId?: ProfileId): MemorySourceRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const profileId = isProfileId(candidate.profileId) ? candidate.profileId : null;
  if (!profileId || (expectedProfileId && profileId !== expectedProfileId)) return null;
  // Older persisted/search projections may omit the derived action. Rebuild it
  // only from the hit's own validated IDs; never accept a model-supplied URL.
  const action = validateOpenMessageAction(candidate.action)
    ?? buildOpenMessageAction(candidate.threadId, candidate.messageId);
  const excerpt = boundedText(candidate.excerpt, MAX_EXCERPT_LENGTH);
  const createdAt = boundedText(candidate.createdAt, 80);
  if (!action || !excerpt || !createdAt) return null;
  const role = candidate.role === "user" || candidate.role === "assistant" || candidate.role === "tool" ? candidate.role : undefined;
  const threadTitle = boundedText(candidate.threadTitle, 120) ?? undefined;
  return { action, profileId, excerpt, createdAt, ...(role ? { role } : {}), ...(threadTitle ? { threadTitle } : {}) };
}

export function memorySourceRows(toolName: string, output: SafeToolJson | undefined, expectedProfileId?: ProfileId): MemorySourceRow[] {
  if (toolName === "search_messages") return getRows(output).map((value) => sourceRow(value, expectedProfileId)).filter((row): row is MemorySourceRow => row !== null).slice(0, 3);
  if (toolName === "read_messages") {
    const object = objectOutput(output);
    const target = object?.target;
    const row = sourceRow(target && typeof target === "object" ? { ...(target as Record<string, unknown>), excerpt: (target as Record<string, unknown>).excerpt ?? (target as Record<string, unknown>).content, action: object.action } : null, expectedProfileId);
    return row ? [row] : [];
  }
  return [];
}

export function canonicalMemoryRows(toolName: string, output: SafeToolJson | undefined): CanonicalMemoryRow[] {
  if (toolName === "memory_read") {
    const object = objectOutput(output);
    if (!object?.document || typeof object.document !== "object" || Array.isArray(object.document)) return [];
    const document = object.document as Record<string, SafeToolJson>;
    const logicalKey = boundedText(document.logicalKey, 200);
    const excerpt = boundedText(document.contentMarkdown, MAX_EXCERPT_LENGTH);
    const documentRevision = typeof document.documentRevision === "number" && Number.isSafeInteger(document.documentRevision) ? document.documentRevision : null;
    const updatedAt = boundedText(document.updatedAt, 80);
    return logicalKey && excerpt && documentRevision !== null && updatedAt ? [{ logicalKey, excerpt, documentRevision, updatedAt }] : [];
  }
  if (toolName !== "memory_list" && toolName !== "memory_search") return [];
  return getRows(output).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const candidate = value as Record<string, unknown>;
    const logicalKey = boundedText(candidate.logicalKey, 200);
    const excerpt = boundedText(candidate.excerpt, MAX_EXCERPT_LENGTH);
    const documentRevision = typeof candidate.documentRevision === "number" && Number.isSafeInteger(candidate.documentRevision) ? candidate.documentRevision : null;
    const updatedAt = boundedText(candidate.updatedAt, 80);
    return logicalKey && excerpt && documentRevision !== null && updatedAt ? [{ logicalKey, excerpt, documentRevision, updatedAt }] : [];
  }).slice(0, 5);
}
