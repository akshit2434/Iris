import { NextResponse } from "next/server";
import { assertAppAccess } from "@/server/auth/gate";
import { getSelectedProfile } from "@/server/auth/profile";
import { createSupabaseMemoryStore } from "@/server/memory/repository";

function excerpt(value: string, max = 280) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1).trimEnd()}…` : compact;
}

export async function GET(request: Request) {
  try { await assertAppAccess(); } catch { return NextResponse.json({ error: "App access is required." }, { status: 401 }); }
  try {
    const profileId = await getSelectedProfile();
    if (!profileId) return NextResponse.json({ error: "Select a profile first." }, { status: 400 });
    const url = new URL(request.url);
    const canonicalKey = url.searchParams.get("canonicalKey")?.trim() || null;
    const includeArchived = url.searchParams.get("archived") === "true";
    const store = createSupabaseMemoryStore();
    const [items, globalRevision] = await Promise.all([store.listItems(profileId, { includeArchived }), store.getCurrentRevision(profileId)]);
    const response: { profileId: typeof profileId; globalRevision: number; items: Array<{ canonicalKey: string; itemRevision: number; category: string; updatedAt: string; status: string; excerpt: string }>; item?: unknown } = {
      profileId, globalRevision,
      items: items.slice(0, 40).map((item) => ({ canonicalKey: item.canonicalKey, itemRevision: item.itemRevision, category: item.category, updatedAt: item.updatedAt, status: item.status, excerpt: excerpt(item.content) })),
    };
    if (canonicalKey) {
      const audit = store.getItemAudit ? await store.getItemAudit(profileId, canonicalKey) : null;
      if (!audit || (!includeArchived && audit.item.status !== "active")) return NextResponse.json({ error: "Memory item not found." }, { status: 404 });
      response.item = {
        canonicalKey: audit.item.canonicalKey,
        content: audit.item.content.slice(0, 20_000),
        itemRevision: audit.item.itemRevision,
        category: audit.item.category,
        status: audit.item.status,
        updatedAt: audit.item.updatedAt,
        revisions: audit.revisions.slice(0, 40).map((revision) => ({
          itemRevision: revision.itemRevision,
          profileGlobalRevision: revision.profileGlobalRevision,
          mutationKind: revision.mutationKind,
          createdAt: revision.createdAt,
          content: revision.content.slice(0, 20_000),
          sources: revision.sources.slice(0, 20).map((source) => ({ sourceKind: source.sourceKind, sourceThreadId: source.sourceThreadId, sourceMessageId: source.sourceMessageId, sourceAgentEventId: source.sourceAgentEventId, sourceAgentRunId: source.sourceAgentRunId, sourceExcerpt: source.sourceExcerpt, metadata: source.metadata, createdAt: source.createdAt, ...(source.action ? { action: source.action } : {}) })),
        })),
      };
    }
    return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "Could not load memory." }, { status: 500 }); }
}
