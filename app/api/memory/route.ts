import { NextResponse } from "next/server";
import { assertAppAccess } from "@/server/auth/gate";
import { getSelectedProfile } from "@/server/auth/profile";
import { createSupabaseMemoryStore } from "@/server/memory/repository";

function excerpt(value: string, max = 280) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1).trimEnd()}…` : compact;
}

export async function GET(request: Request) {
  try {
    await assertAppAccess();
  } catch {
    return NextResponse.json({ error: "App access is required." }, { status: 401 });
  }
  try {
    const profileId = await getSelectedProfile();
    if (!profileId) return NextResponse.json({ error: "Select a profile first." }, { status: 400 });
    const url = new URL(request.url);
    const logicalKey = url.searchParams.get("logicalKey")?.trim() || null;
    const includeArchived = url.searchParams.get("archived") === "true";
    const store = createSupabaseMemoryStore();
    const [documents, globalRevision] = await Promise.all([
      store.listDocuments(profileId, { includeArchived }),
      store.getCurrentRevision(profileId),
    ]);
    const response: {
      profileId: typeof profileId;
      globalRevision: number;
      documents: Array<{ logicalKey: string; documentRevision: number; updatedAt: string; archivedAt: string | null; excerpt: string }>;
      document?: unknown;
    } = {
      profileId,
      globalRevision,
      documents: documents.slice(0, 40).map((document) => ({
        logicalKey: document.logicalKey,
        documentRevision: document.documentRevision,
        updatedAt: document.updatedAt,
        archivedAt: document.archivedAt,
        excerpt: excerpt(document.contentMarkdown),
      })),
    };
    if (logicalKey) {
      const audit = store.getDocumentAudit ? await store.getDocumentAudit(profileId, logicalKey) : null;
      if (!audit || (!includeArchived && audit.document.archivedAt)) return NextResponse.json({ error: "Memory document not found." }, { status: 404 });
      response.document = {
        logicalKey: audit.document.logicalKey,
        contentMarkdown: audit.document.contentMarkdown.slice(0, 20_000),
        documentRevision: audit.document.documentRevision,
        updatedAt: audit.document.updatedAt,
        archivedAt: audit.document.archivedAt,
        revisions: audit.revisions.slice(0, 40).map((revision) => ({
          documentRevision: revision.documentRevision,
          profileGlobalRevision: revision.profileGlobalRevision,
          mutationKind: revision.mutationKind,
          createdAt: revision.createdAt,
          contentMarkdown: revision.contentMarkdown.slice(0, 20_000),
          provenance: revision.provenance.slice(0, 5).map((source) => ({
            sourceKind: source.sourceKind,
            sourceExcerpt: source.sourceExcerpt,
            createdAt: source.createdAt,
            ...(source.action ? { action: source.action } : {}),
          })),
        })),
      };
    }
    return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not load memory." }, { status: 500 });
  }
}
