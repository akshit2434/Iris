import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProfileId } from "@/lib/profiles";
import { getDatabase } from "@/server/db/client";
import type { Database, Json } from "@/server/db/types";

export const FILE_STORAGE_BUCKET = "iris-files";
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_FILE_READ_CHARS = 200_000;

type FileTableRow = Database["public"]["Tables"]["files"]["Row"];
type FileDatabase = SupabaseClient<Database>;

export type FileRecordKind = "upload" | "artifact";

export type FileRecord = {
  id: string;
  profileId: ProfileId;
  name: string;
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
  recordKind: FileRecordKind;
  sourceThreadId: string | null;
  sourceMessageId: string | null;
  metadata: Json;
  createdAt: string;
  updatedAt: string;
};

export type FileListOptions = {
  query?: string;
  kind?: FileRecordKind;
  limit?: number;
};

export type FileRepository = {
  list(profileId: ProfileId, options?: FileListOptions): Promise<FileRecord[]>;
  get(profileId: ProfileId, fileId: string, kind?: FileRecordKind): Promise<FileRecord | null>;
  upload(input: {
    profileId: ProfileId;
    fileId: string;
    name: string;
    mimeType: string;
    bytes: ArrayBuffer;
    sourceThreadId?: string | null;
    sourceMessageId?: string | null;
  }): Promise<FileRecord>;
  createSignedUrl(record: FileRecord, expiresInSeconds?: number): Promise<string>;
  readText(record: FileRecord, maxChars?: number): Promise<{ text: string; truncated: boolean } | null>;
};

function mapFile(row: FileTableRow): FileRecord {
  return {
    id: row.id,
    profileId: row.profile_id,
    name: row.name,
    storagePath: row.storage_path,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    recordKind: row.record_kind,
    sourceThreadId: row.source_thread_id,
    sourceMessageId: row.source_message_id,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function isTextLike(record: Pick<FileRecord, "name" | "mimeType">) {
  if (record.mimeType.startsWith("text/")) return true;
  return /^(application|image)\/(json|xml|javascript|typescript|yaml|x-yaml|sql|graphql|svg\+xml)$/.test(record.mimeType)
    || /\.(csv|md|markdown|mdx|txt|json|jsonl|xml|yaml|yml|toml|ini|env|sql|graphql|js|jsx|ts|tsx|css|html)$/i.test(record.name);
}

function normalizedName(name: string) {
  const value = name
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\/]/g, "_")
    .trim()
    .slice(0, 255);
  return value || "untitled-file";
}

export function buildStoragePath(profileId: ProfileId, fileId: string, name: string) {
  return `${profileId}/${fileId}/${normalizedName(name)}`;
}

export function createFileRepository(client: FileDatabase = getDatabase()): FileRepository {
  return {
    async list(profileId, options = {}) {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
      let query = client
        .from("files")
        .select("*")
        .eq("profile_id", profileId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (options.kind) query = query.eq("record_kind", options.kind);
      if (options.query?.trim()) query = query.ilike("name", `%${escapeLike(options.query.trim())}%`);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []).map(mapFile);
    },

    async get(profileId, fileId, kind) {
      let query = client
        .from("files")
        .select("*")
        .eq("profile_id", profileId)
        .eq("id", fileId);
      if (kind) query = query.eq("record_kind", kind);
      const { data, error } = await query.maybeSingle();
      if (error) throw error;
      return data ? mapFile(data) : null;
    },

    async upload(input) {
      if (input.bytes.byteLength > MAX_FILE_BYTES) throw new Error("File exceeds the 50 MiB limit.");
      const storagePath = buildStoragePath(input.profileId, input.fileId, input.name);
      const storage = client.storage.from(FILE_STORAGE_BUCKET);
      const uploadResult = await storage.upload(storagePath, input.bytes, {
        contentType: input.mimeType,
        cacheControl: "3600",
        upsert: false,
      });
      if (uploadResult.error) throw uploadResult.error;

      const { data, error } = await client
        .from("files")
        .insert({
          id: input.fileId,
          profile_id: input.profileId,
          name: normalizedName(input.name),
          storage_path: storagePath,
          mime_type: input.mimeType,
          size_bytes: input.bytes.byteLength,
          record_kind: "upload",
          source_thread_id: input.sourceThreadId ?? null,
          source_message_id: input.sourceMessageId ?? null,
        })
        .select("*")
        .single();
      if (error) {
        await storage.remove([storagePath]).catch(() => undefined);
        throw error;
      }
      return mapFile(data);
    },

    async createSignedUrl(record, expiresInSeconds = 300) {
      const { data, error } = await client.storage
        .from(FILE_STORAGE_BUCKET)
        .createSignedUrl(record.storagePath, Math.min(Math.max(expiresInSeconds, 60), 900));
      if (error || !data?.signedUrl) throw error ?? new Error("Could not create a file URL.");
      return data.signedUrl;
    },

    async readText(record, maxChars = MAX_FILE_READ_CHARS) {
      if (!isTextLike(record)) return null;
      const { data, error } = await client.storage.from(FILE_STORAGE_BUCKET).download(record.storagePath);
      if (error || !data) throw error ?? new Error("Could not download file.");
      const truncated = data.size > maxChars;
      const text = await data.slice(0, maxChars).text();
      return { text, truncated };
    },
  };
}

export function fileSummary(record: FileRecord) {
  return {
    fileId: record.id,
    name: record.name,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    recordKind: record.recordKind,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    sourceThreadId: record.sourceThreadId,
    sourceMessageId: record.sourceMessageId,
  };
}
