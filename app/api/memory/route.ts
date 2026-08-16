import { NextResponse } from "next/server";
import { assertAppAccess } from "@/server/auth/gate";
import { getSelectedProfile } from "@/server/auth/profile";
import { createSupabaseMemoryStore } from "@/server/memory/repository";
import { createSupabaseReferenceHistoryStore } from "@/server/memory/reference-history-repository";

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
    const response: { profileId: typeof profileId; globalRevision: number; items: Array<{ canonicalKey: string; itemRevision: number; category: string; origin: string; updatedAt: string; status: string; excerpt: string }>; item?: unknown } = {
      profileId, globalRevision,
      items: items.slice(0, 40).map((item) => ({ canonicalKey: item.canonicalKey, itemRevision: item.itemRevision, category: item.category, origin: item.origin, updatedAt: item.updatedAt, status: item.status, excerpt: excerpt(item.content) })),
    };
    if (canonicalKey) {
      const audit = store.getItemAudit ? await store.getItemAudit(profileId, canonicalKey) : null;
      if (!audit || (!includeArchived && audit.item.status !== "active")) return NextResponse.json({ error: "Memory item not found." }, { status: 404 });
      response.item = {
        canonicalKey: audit.item.canonicalKey,
        content: audit.item.content.slice(0, 20_000),
        itemRevision: audit.item.itemRevision,
        category: audit.item.category,
        origin: audit.item.origin,
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

export async function PATCH(request: Request) {
  try { await assertAppAccess(); } catch { return NextResponse.json({ error: "App access is required." }, { status: 401 }); }
  try {
    const profileId = await getSelectedProfile();
    if (!profileId) return NextResponse.json({ error: "Select a profile first." }, { status: 400 });
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const canonicalKey = typeof body?.canonicalKey === "string" ? body.canonicalKey.trim() : "";
    const action = body?.action;
    const expectedItemRevision = typeof body?.expectedItemRevision === "number" && Number.isSafeInteger(body.expectedItemRevision) ? body.expectedItemRevision : null;
    if (!canonicalKey || canonicalKey.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(canonicalKey)) return NextResponse.json({ error: "Memory item key is invalid." }, { status: 400 });
    if ((action !== "update" && action !== "archive") || expectedItemRevision === null || expectedItemRevision < 1) return NextResponse.json({ error: "Memory action or revision is invalid." }, { status: 400 });

    const store = createSupabaseMemoryStore();
    const item = await store.getItem(profileId, canonicalKey, { includeArchived: true });
    if (!item || item.status !== "active") return NextResponse.json({ error: "That memory item is no longer active." }, { status: 409 });
    if (item.itemRevision !== expectedItemRevision) return NextResponse.json({ error: "That memory changed. Reload it and try again." }, { status: 409 });

    const content = action === "archive" ? item.content : typeof body?.content === "string" ? body.content.trim() : "";
    if (!content || content.length > 20_000) return NextResponse.json({ error: "Correction must be between 1 and 20,000 characters." }, { status: 400 });
    const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 240) : null;
    const revision = await store.applyItemRevision({
      profileId,
      canonicalKey,
      content,
      category: item.category,
      valueScope: item.valueScope,
      origin: "explicit",
      confidence: 1,
      importance: item.importance,
      sensitivity: item.sensitivity,
      status: action === "archive" ? "archived" : "active",
      mutationKind: action === "archive" ? "archive" : "update",
      expectedItemRevision,
      idempotencyKey: `memory-ui:${crypto.randomUUID()}`,
      provenance: {
        sourceKind: "manual",
        sourceExcerpt: reason ?? (action === "archive" ? "User requested this memory be forgotten." : "User corrected this memory."),
        relation: action === "archive" ? "supersedes" : "corrects",
        metadata: { explicit: true, action },
      },
    });
    return NextResponse.json({ ok: true, action, revision }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not update memory." }, { status: 500 });
  }
}

export async function DELETE() {
  try { await assertAppAccess(); } catch { return NextResponse.json({ error: "App access is required." }, { status: 401 }); }
  try {
    const profileId = await getSelectedProfile();
    if (!profileId) return NextResponse.json({ error: "Select a profile first." }, { status: 400 });
    const store = createSupabaseMemoryStore();
    const activeItems = await store.listItems(profileId);
    let archived = 0;
    for (const item of activeItems) {
      try {
        await store.applyItemRevision({
          profileId,
          canonicalKey: item.canonicalKey,
          content: item.content,
          category: item.category,
          valueScope: item.valueScope,
          origin: "explicit",
          confidence: 1,
          importance: item.importance,
          sensitivity: item.sensitivity,
          status: "archived",
          mutationKind: "archive",
          expectedItemRevision: item.itemRevision,
          idempotencyKey: `memory-clear:${crypto.randomUUID()}`,
          provenance: {
            sourceKind: "manual",
            sourceExcerpt: "User removed all saved memory.",
            relation: "supersedes",
            metadata: { explicit: true, action: "clear_all" },
          },
        });
        archived += 1;
      } catch {
        // A concurrent edit should not prevent the remaining profile items
        // from being cleared. The response reports only successful changes.
      }
    }
    const referenceStore = createSupabaseReferenceHistoryStore();
    if (referenceStore.clearReferenceHistoryData) await referenceStore.clearReferenceHistoryData(profileId);
    return NextResponse.json({ ok: true, archived, rawChatsRetained: true, derivedReferenceHistoryCleared: Boolean(referenceStore.clearReferenceHistoryData) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not clear memory." }, { status: 500 });
  }
}
