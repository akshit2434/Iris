import "server-only";

import type { ProfileId } from "@/lib/profiles";
import {
  createProductionAccountabilityRepository,
  normalizeSuppressionSubject,
  type AccountabilityRepository,
  type OpenLoopRow,
} from "./repository";
import type { CadenceKind, OpenLoopKind, OpenLoopStatus } from "./types";

export const OPEN_LOOP_CONTEXT_MAX_ITEMS = 12;
export const OPEN_LOOP_TITLE_MAX_LENGTH = 120;
const MS_PER_DAY = 86_400_000;

export const ACTIVE_LOOP_STATUSES = ["open", "paused"] as const;

export type OpenLoopContextEntry = {
  loopId: string;
  title: string;
  kind: OpenLoopKind;
  status: (typeof ACTIVE_LOOP_STATUSES)[number];
  dueAt: string | null;
  cadenceKind: CadenceKind | null;
  createdAt: string;
};

export type LoadOpenLoopContextOptions = { limit?: number; now?: string };

const KIND_RANK: Record<OpenLoopKind, number> = { commitment: 0, routine: 1, idea: 2 };

function isActiveStatus(status: OpenLoopStatus): status is OpenLoopContextEntry["status"] {
  return status === "open" || status === "paused";
}

function isActiveRow(row: OpenLoopRow): row is OpenLoopRow & { status: OpenLoopContextEntry["status"] } {
  return isActiveStatus(row.status);
}

function compareForContext(left: OpenLoopRow, right: OpenLoopRow): number {
  const kindDelta = KIND_RANK[left.kind] - KIND_RANK[right.kind];
  if (kindDelta !== 0) return kindDelta;
  if (left.kind === "commitment") {
    const leftMissingDue = left.dueAt === null ? 1 : 0;
    const rightMissingDue = right.dueAt === null ? 1 : 0;
    if (leftMissingDue !== rightMissingDue) return leftMissingDue - rightMissingDue;
    if (left.dueAt !== null && right.dueAt !== null && left.dueAt !== right.dueAt) {
      return left.dueAt.localeCompare(right.dueAt);
    }
  }
  const recency = right.updatedAt.localeCompare(left.updatedAt);
  return recency !== 0 ? recency : left.id.localeCompare(right.id);
}

function toContextEntry(row: OpenLoopRow & { status: OpenLoopContextEntry["status"] }): OpenLoopContextEntry {
  return {
    loopId: row.id,
    title: row.title.replace(/[\r\n]+/g, " ").slice(0, OPEN_LOOP_TITLE_MAX_LENGTH),
    kind: row.kind,
    status: row.status,
    dueAt: row.dueAt,
    cadenceKind: row.cadence?.kind ?? null,
    createdAt: row.createdAt,
  };
}

export async function loadOpenLoopsForProfile(
  repository: AccountabilityRepository,
  profileId: ProfileId,
  options: LoadOpenLoopContextOptions = {},
): Promise<OpenLoopContextEntry[]> {
  const limit = Math.max(0, Math.min(options.limit ?? OPEN_LOOP_CONTEXT_MAX_ITEMS, OPEN_LOOP_CONTEXT_MAX_ITEMS));
  const rows = await repository.listOpenLoops(profileId, { statuses: [...ACTIVE_LOOP_STATUSES] });
  if (rows.length === 0) return [];
  const suppressions = await repository.listActiveSuppressions(profileId);
  const suppressedSubjects = new Set(suppressions.map((suppression) => normalizeSuppressionSubject(suppression.subject)));
  return rows
    .filter(isActiveRow)
    .filter((row) => !suppressedSubjects.has(normalizeSuppressionSubject(row.title)))
    .sort(compareForContext)
    .slice(0, limit)
    .map(toContextEntry);
}

export async function loadOpenLoopContext(profileId: ProfileId, options: LoadOpenLoopContextOptions = {}): Promise<OpenLoopContextEntry[]> {
  return loadOpenLoopsForProfile(createProductionAccountabilityRepository(), profileId, options);
}

function escapePrompt(value: string) {
  return value.replace(/[<>]/g, (character) => character === "<" ? "&lt;" : "&gt;");
}

function describeEntry(entry: OpenLoopContextEntry, nowMs: number): string {
  if (entry.kind === "idea") return "background idea — do not track";
  if (!entry.dueAt) return `${entry.status}, no date`;
  const dueMs = Date.parse(entry.dueAt);
  if (!Number.isFinite(dueMs)) return `${entry.status}, no date`;
  if (entry.status === "open" && dueMs < nowMs) {
    return `${entry.status}, overdue ${Math.floor((nowMs - dueMs) / MS_PER_DAY)} d`;
  }
  return `${entry.status}, due ${entry.dueAt.slice(0, 10)}`;
}

export function formatOpenLoopsPrompt(entries: readonly OpenLoopContextEntry[], nowIso: string): string {
  if (entries.length === 0) return "";
  const nowMs = Date.parse(nowIso);
  const body = entries.map((entry) => `- [${entry.kind}] ${escapePrompt(entry.title)} (${describeEntry(entry, nowMs)})`).join("\n");
  return `<open-loops>\n${body}\n</open-loops>`;
}
