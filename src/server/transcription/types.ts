import type { ProfileId } from "@/lib/profiles";

export type VoiceTranscriptionStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";

export type VoiceTranscription = {
  id: string;
  profileId: ProfileId;
  provider: "assemblyai";
  providerTranscriptId: string;
  status: VoiceTranscriptionStatus;
  transcript: string | null;
  errorMessage: string | null;
  vocabularyTermCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type VoiceVocabularyEntry = {
  id: string;
  profileId: ProfileId;
  term: string;
  source: "correction" | "manual";
  occurrenceCount: number;
  createdAt: string;
  updatedAt: string;
};

export type VoiceTranscriptionStore = {
  create: (input: { profileId: ProfileId; providerTranscriptId: string; vocabularyTermCount: number }) => Promise<VoiceTranscription>;
  get: (profileId: ProfileId, id: string) => Promise<VoiceTranscription | null>;
  markStatus: (input: { profileId: ProfileId; id: string; status: VoiceTranscriptionStatus; transcript?: string | null; errorMessage?: string | null; completed?: boolean }) => Promise<VoiceTranscription>;
  listVocabulary: (profileId: ProfileId, limit?: number) => Promise<VoiceVocabularyEntry[]>;
  learnVocabulary: (input: { profileId: ProfileId; terms: readonly string[]; source?: "correction" | "manual" }) => Promise<VoiceVocabularyEntry[]>;
};
