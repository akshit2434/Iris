import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getDatabase } from "@/server/db/client";
import type { ProfileId } from "@/lib/profiles";
import { isProfileId } from "@/lib/profiles";
import type { Database } from "@/server/db/types";
import type { VoiceTranscription, VoiceTranscriptionStore, VoiceVocabularyEntry } from "@/server/transcription/types";

type VoiceDatabase = SupabaseClient<Database>;
type VoiceTranscriptionRow = Database["public"]["Tables"]["voice_transcriptions"]["Row"];
type VoiceVocabularyRow = Database["public"]["Tables"]["voice_vocabulary"]["Row"];

function assertProfile(profileId: ProfileId) {
  if (!isProfileId(profileId)) throw new Error("Invalid profile.");
}

function toTranscription(row: VoiceTranscriptionRow): VoiceTranscription {
  return {
    id: row.id,
    profileId: row.profile_id,
    provider: row.provider,
    providerTranscriptId: row.provider_transcript_id,
    status: row.status,
    transcript: row.transcript,
    errorMessage: row.error_message,
    vocabularyTermCount: row.vocabulary_term_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function toVocabulary(row: VoiceVocabularyRow): VoiceVocabularyEntry {
  return {
    id: row.id,
    profileId: row.profile_id,
    term: row.term,
    source: row.source,
    occurrenceCount: row.occurrence_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createVoiceTranscriptionStore(database: VoiceDatabase = getDatabase()): VoiceTranscriptionStore {
  return {
    async create(input) {
      assertProfile(input.profileId);
      const { data, error } = await database.from("voice_transcriptions").insert({
        profile_id: input.profileId,
        provider_transcript_id: input.providerTranscriptId,
        vocabulary_term_count: input.vocabularyTermCount,
      }).select("*").single();
      if (error) throw error;
      return toTranscription(data);
    },

    async get(profileId, id) {
      assertProfile(profileId);
      const { data, error } = await database.from("voice_transcriptions").select("*").eq("profile_id", profileId).eq("id", id).maybeSingle();
      if (error) throw error;
      return data ? toTranscription(data) : null;
    },

    async markStatus(input) {
      assertProfile(input.profileId);
      const { data, error } = await database.from("voice_transcriptions").update({
        status: input.status,
        ...(input.transcript !== undefined ? { transcript: input.transcript } : {}),
        ...(input.errorMessage !== undefined ? { error_message: input.errorMessage } : {}),
        ...(input.completed ? { completed_at: new Date().toISOString() } : {}),
      }).eq("profile_id", input.profileId).eq("id", input.id).select("*").single();
      if (error) throw error;
      return toTranscription(data);
    },

    async listVocabulary(profileId, limit = 100) {
      assertProfile(profileId);
      const { data, error } = await database.from("voice_vocabulary").select("*").eq("profile_id", profileId).order("occurrence_count", { ascending: false }).order("updated_at", { ascending: false }).limit(Math.min(Math.max(limit, 1), 1000));
      if (error) throw error;
      return (data ?? []).map(toVocabulary);
    },

    async learnVocabulary(input) {
      assertProfile(input.profileId);
      const source = input.source ?? "correction";
      const learned: VoiceVocabularyEntry[] = [];
      for (const term of [...new Set(input.terms.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, 20)) {
        const { data: existing, error: existingError } = await database.from("voice_vocabulary").select("*").eq("profile_id", input.profileId).eq("normalized_term", term.toLocaleLowerCase()).maybeSingle();
        if (existingError) throw existingError;
        if (existing) {
          const { data, error } = await database.from("voice_vocabulary").update({ occurrence_count: existing.occurrence_count + 1, term, source }).eq("profile_id", input.profileId).eq("id", existing.id).select("*").single();
          if (error) throw error;
          learned.push(toVocabulary(data));
        } else {
          const { data, error } = await database.from("voice_vocabulary").insert({ profile_id: input.profileId, term, source }).select("*").single();
          if (error) throw error;
          learned.push(toVocabulary(data));
        }
      }
      return learned;
    },
  };
}
