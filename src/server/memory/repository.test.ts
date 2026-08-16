import { describe, expect, it } from "vitest";
import { createSupabaseMemoryStore } from "@/server/memory/repository";

function fakeDatabase() {
  const calls: Array<{ operation: string; table?: string; field?: string; value?: unknown; params?: unknown }> = [];
  const rows = {
    memory_items: [{ id: "item-a", profile_id: "profile-a", canonical_key: "profile.communication", content: "Prefers concise answers", item_revision: 1, category: "preference", value_scope: "single", origin: "explicit", confidence: 1, importance: 0.5, sensitivity: "normal", status: "active", valid_from: null, valid_until: null, last_confirmed_at: null, superseded_by_item_id: null, created_at: "now", updated_at: "now", archived_at: null, deleted_at: null }],
    profile_memory_state: [{ current_revision: 4 }], message_semantic_index: [],
  } as Record<string, unknown[]>;
  const chain = (table: string) => {
    const builder: Record<string, (...args: unknown[]) => unknown> = {};
    let filtered = rows[table] ?? [];
    builder.select = () => builder;
    builder.eq = (field: unknown, value: unknown) => { calls.push({ operation: "eq", table, field: String(field), value }); filtered = filtered.filter((row) => (row as Record<string, unknown>)[String(field)] === value); return builder; };
    builder.in = (field: unknown, values: unknown) => { calls.push({ operation: "in", table, field: String(field), value: values }); filtered = filtered.filter((row) => (values as unknown[]).includes((row as Record<string, unknown>)[String(field)])); return builder; };
    builder.is = (field: unknown, value: unknown) => { calls.push({ operation: "is", table, field: String(field), value }); return builder; };
    builder.order = () => builder;
    builder.limit = () => builder;
    builder.maybeSingle = () => Promise.resolve({ data: filtered[0] ?? null, error: null });
    builder.upsert = (value: unknown) => { calls.push({ operation: "upsert", table, params: value }); return Promise.resolve({ error: null }); };
    builder.then = (...args: unknown[]) => { const resolve = args[0] as ((value: unknown) => unknown) | undefined; const promise = Promise.resolve({ data: filtered, error: null }); return resolve ? promise.then(resolve) : promise; };
    return builder;
  };
  const database = {
    from(table: string) { calls.push({ operation: "from", table }); return chain(table); },
    rpc(name: string, params: unknown) { calls.push({ operation: "rpc", table: name, params }); if (name === "search_messages" && (params as { p_profile_id?: string }).p_profile_id === "profile-b") return Promise.resolve({ data: [], error: null }); return Promise.resolve({ data: [{ profile_id: "profile-a", item_id: "item-a", canonical_key: "profile.communication", item_revision: 2, profile_global_revision: 5, revision_id: "rev-a", source_id: "source-a", content_hash: "a".repeat(64) }], error: null }); },
  };
  return { database, calls };
}

function readFakeDatabase() {
  const calls: Array<{ operation: string; table?: string; field?: string; value?: unknown }> = [];
  const messages = [{ id: "00000000-0000-4000-8000-000000000009", thread_id: "00000000-0000-4000-8000-000000000011", profile_id: "profile-a", role: "user", content: "before", created_at: "2026-08-14T11:00:00.000Z" }, { id: "00000000-0000-4000-8000-000000000010", thread_id: "00000000-0000-4000-8000-000000000011", profile_id: "profile-a", role: "assistant", content: "target", created_at: "2026-08-14T12:00:00.000Z" }, { id: "00000000-0000-4000-8000-000000000012", thread_id: "00000000-0000-4000-8000-000000000011", profile_id: "profile-a", role: "user", content: "after", created_at: "2026-08-14T13:00:00.000Z" }];
  const threads = [{ id: "00000000-0000-4000-8000-000000000011", profile_id: "profile-a", title: "History", created_at: "2026-08-14T10:00:00.000Z", updated_at: "2026-08-14T13:00:00.000Z" }];
  const chain = (table: string) => {
    const builder: Record<string, (...args: unknown[]) => unknown> = {}; let filtered: unknown[] = table === "messages" ? messages : threads;
    builder.select = () => builder; builder.eq = (field: unknown, value: unknown) => { calls.push({ operation: "eq", table, field: String(field), value }); filtered = filtered.filter((row) => (row as Record<string, unknown>)[String(field)] === value); return builder; };
    builder.or = (value: unknown) => { calls.push({ operation: "or", table, value }); const match = String(value).match(/created_at\.(lt|gt)\.([^,]+)/); if (match) { const [, direction, timestamp] = match; filtered = filtered.filter((row) => direction === "lt" ? (row as { created_at: string }).created_at < timestamp : (row as { created_at: string }).created_at > timestamp); } return builder; };
    builder.order = () => builder; builder.limit = () => builder; builder.maybeSingle = () => Promise.resolve({ data: filtered[0] ?? null, error: null }); builder.then = (...args: unknown[]) => { const resolve = args[0] as ((value: unknown) => unknown) | undefined; const promise = Promise.resolve({ data: filtered, error: null }); return resolve ? promise.then(resolve) : promise; }; return builder;
  };
  return { database: { from: (table: string) => { calls.push({ operation: "from", table }); return chain(table); } }, calls };
}

describe("profile-scoped structured memory repository", () => {
  it("always adds profile predicates and keeps profile in RPC requests", async () => {
    const { database, calls } = fakeDatabase(); const store = createSupabaseMemoryStore(database as never);
    await expect(store.listItems("profile-b")).resolves.toEqual([]); expect(calls).toContainEqual({ operation: "eq", table: "memory_items", field: "profile_id", value: "profile-b" });
    calls.length = 0; await expect(store.getItem("profile-a", "profile.communication")).resolves.toMatchObject({ profileId: "profile-a", canonicalKey: "profile.communication" }); expect(calls).toContainEqual({ operation: "eq", table: "memory_items", field: "profile_id", value: "profile-a" }); expect(calls).toContainEqual({ operation: "eq", table: "memory_items", field: "canonical_key", value: "profile.communication" });
    calls.length = 0; await expect(store.searchMessages({ profileId: "profile-b", query: "T1" })).resolves.toEqual([]); expect(calls[0]).toMatchObject({ operation: "rpc", table: "search_messages" }); expect((calls[0].params as { p_profile_id: string }).p_profile_id).toBe("profile-b"); expect((calls[0].params as { p_query_embedding: number[] | null }).p_query_embedding).toBeNull();
  });
  it("does not surface saved memories from stop-word substring matches", async () => {
    const { database } = fakeDatabase(); const store = createSupabaseMemoryStore(database as never);
    await expect(store.searchItems("profile-a", "with an answer", 5)).resolves.toEqual([]);
    await expect(store.searchItems("profile-a", "concise answer", 5)).resolves.toEqual([
      expect.objectContaining({ canonicalKey: "profile.communication", excerpt: "Prefers concise answers" }),
    ]);
  });
  it("maps the atomic item RPC response and validates before the database", async () => {
    const { database, calls } = fakeDatabase(); const store = createSupabaseMemoryStore(database as never);
    await expect(store.applyItemRevision({ profileId: "profile-a", canonicalKey: "profile.communication", content: "Prefers concise answers", status: "active", mutationKind: "update", expectedItemRevision: 1 })).resolves.toEqual({ profileId: "profile-a", itemId: "item-a", canonicalKey: "profile.communication", itemRevision: 2, profileGlobalRevision: 5, revisionId: "rev-a", sourceId: "source-a", contentHash: "a".repeat(64) });
    expect(calls[0]).toMatchObject({ operation: "rpc", table: "apply_memory_item_revision" }); const before = calls.length;
    await expect(store.applyItemRevision({ profileId: "profile-a", canonicalKey: "profile.communication", content: "", status: "active", mutationKind: "update" })).rejects.toThrow("non-empty natural language"); expect(calls).toHaveLength(before);
  });
  it("reads an exact message window only inside the requested profile", async () => {
    const { database, calls } = readFakeDatabase(); const store = createSupabaseMemoryStore(database as never);
    await expect(store.readMessageContext("profile-a", "00000000-0000-4000-8000-000000000010", 1)).resolves.toMatchObject({ target: { content: "target" }, before: [{ content: "before" }], after: [{ content: "after" }], thread: { id: "00000000-0000-4000-8000-000000000011", profileId: "profile-a" } });
    expect(calls.filter((call) => call.operation === "eq" && call.field === "profile_id")).toHaveLength(4); calls.length = 0; await expect(store.readMessageContext("profile-b", "00000000-0000-4000-8000-000000000010", 1)).resolves.toBeNull(); await expect(store.readMessageContext("profile-a", "00000000-0000-4000-8000-000000000099", 1)).resolves.toBeNull();
  });
});
