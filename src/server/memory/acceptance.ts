import type { MemoryRevisionDelta } from "@/server/memory/types";
import { buildOpenMessageHref } from "@/lib/memory-source";
import { collapseMemoryChanges } from "@/server/memory/reconciliation";

export type DeterministicMemoryAcceptanceDeps = {
  patchFact: () => Promise<{ status: "applied"; canonicalKey: string; profileGlobalRevision: number }>;
  searchExactSource: (query: string) => Promise<Array<{ messageId: string; threadId: string; excerpt: string }>>;
  readCanonicalFact: (canonicalKey: string) => Promise<{ canonicalKey: string; content: string } | null>;
  readChanges: (afterRevision: number, throughRevision: number) => Promise<MemoryRevisionDelta[]>;
};

/** A no-network acceptance flow for tests and a future bounded live runner. */
export async function runDeterministicMemoryAcceptance(deps: DeterministicMemoryAcceptanceDeps) {
  const applied = await deps.patchFact();
  if (applied.status !== "applied") throw new Error("Acceptance fact was not applied.");
  const recalled = await deps.readCanonicalFact(applied.canonicalKey);
  const hits = await deps.searchExactSource("durable fact");
  const source = hits[0] ? buildOpenMessageHref(hits[0]) : null;
  const changes = await deps.readChanges(0, applied.profileGlobalRevision);
  return {
    chatA: { status: applied.status, canonicalKey: applied.canonicalKey },
    chatB: { recalled: Boolean(recalled), exactSourceFound: hits.length > 0, sourceHref: source },
    oldChatA: collapseMemoryChanges(changes, 0, applied.profileGlobalRevision),
  };
}
