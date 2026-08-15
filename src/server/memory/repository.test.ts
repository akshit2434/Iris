import { describe, expect, it } from "vitest";
import { createSupabaseMemoryStore } from "@/server/memory/repository";

function fakeDatabase() {
  const calls: Array<{ operation: string; table?: string; field?: string; value?: unknown; params?: unknown }> = [];
  const rows = {
    memory_documents: [{ id: "doc-a", profile_id: "profile-a", logical_key: "CURRENT.md", content_markdown: "# Current", document_revision: 1, content_hash: "a".repeat(64), created_at: "now", updated_at: "now", archived_at: null }],
    profile_memory_state: [{ current_revision: 4 }],
    message_semantic_index: [],
  } as Record<string, unknown[]>;
  const chain = (table: string) => {
    const builder: Record<string, (...args: unknown[]) => unknown> = {};
    let filtered = rows[table] ?? [];
    builder.select = () => builder;
    builder.eq = (field: unknown, value: unknown) => { calls.push({ operation: "eq", table, field: String(field), value }); filtered = filtered.filter((row) => (row as Record<string, unknown>)[String(field)] === value); return builder; };
    builder.is = (field: unknown, value: unknown) => { calls.push({ operation: "is", table, field: String(field), value }); return builder; };
    builder.order = () => Promise.resolve({ data: filtered, error: null });
    builder.maybeSingle = () => Promise.resolve({ data: filtered[0] ?? null, error: null });
    builder.upsert = (value: unknown) => { calls.push({ operation: "upsert", table, params: value }); return Promise.resolve({ error: null }); };
    return builder;
  };
  const database = {
    from(table: string) {
      calls.push({ operation: "from", table });
      return chain(table);
    },
    rpc(name: string, params: unknown) {
      calls.push({ operation: "rpc", table: name, params });
      if (name === "search_messages" && (params as { p_profile_id?: string }).p_profile_id === "profile-b") return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: [{ profile_id: "profile-a", document_id: "doc-a", document_revision: 2, profile_global_revision: 5, revision_id: "rev-a", provenance_id: "prov-a" }], error: null });
    },
  };
  return { database, calls };
}

describe("profile-scoped memory repository", () => {
  it("always adds profile predicates and keeps profile in RPC requests", async () => {
    const { database, calls } = fakeDatabase();
    const store = createSupabaseMemoryStore(database as never);
    await expect(store.listDocuments("profile-b")).resolves.toEqual([]);
    expect(calls).toContainEqual({ operation: "eq", table: "memory_documents", field: "profile_id", value: "profile-b" });

    calls.length = 0;
    await expect(store.getDocument("profile-a", "CURRENT.md")).resolves.toMatchObject({ profileId: "profile-a", logicalKey: "CURRENT.md" });
    expect(calls).toContainEqual({ operation: "eq", table: "memory_documents", field: "profile_id", value: "profile-a" });
    expect(calls).toContainEqual({ operation: "eq", table: "memory_documents", field: "logical_key", value: "CURRENT.md" });

    calls.length = 0;
    await expect(store.searchMessages({ profileId: "profile-b", query: "T1" })).resolves.toEqual([]);
    expect(calls[0]).toMatchObject({ operation: "rpc", table: "search_messages" });
    expect((calls[0].params as { p_profile_id: string }).p_profile_id).toBe("profile-b");
    expect((calls[0].params as { p_query_embedding: number[] | null }).p_query_embedding).toBeNull();

    calls.length = 0;
    await store.searchMessages({ profileId: "profile-a", query: "T1", queryEmbedding: Array.from({ length: 1536 }, () => 0) });
    expect((calls[0].params as { p_query_embedding: number[] | null }).p_query_embedding).toHaveLength(1536);
  });

  it("maps the atomic RPC response and keeps revision validation before the database", async () => {
    const { database, calls } = fakeDatabase();
    const store = createSupabaseMemoryStore(database as never);
    await expect(store.applyDocumentRevision({ profileId: "profile-a", logicalKey: "CURRENT.md", contentMarkdown: "# Current", mutationKind: "update", expectedDocumentRevision: 1 })).resolves.toEqual({
      profileId: "profile-a", documentId: "doc-a", documentRevision: 2, profileGlobalRevision: 5, revisionId: "rev-a", provenanceId: "prov-a",
    });
    expect(calls[0]).toMatchObject({ operation: "rpc", table: "apply_memory_document_revision" });
    const before = calls.length;
    await expect(store.applyDocumentRevision({ profileId: "profile-a", logicalKey: "CURRENT.md", contentMarkdown: "", mutationKind: "update" })).rejects.toThrow("non-empty natural Markdown");
    expect(calls).toHaveLength(before);
  });
});
