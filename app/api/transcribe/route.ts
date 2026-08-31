import { NextResponse } from "next/server";
import { assertAppAccess } from "@/server/auth/gate";
import { getSelectedProfile } from "@/server/auth/profile";
import { createSupabaseMemoryStore } from "@/server/memory/repository";
import { buildAssemblyPrompt, buildVoiceContextPrompt, buildVoiceKeyterms } from "@/server/transcription/context";
import { createAssemblyAIClient } from "@/server/transcription/assemblyai";
import { createVoiceTranscriptionStore } from "@/server/transcription/repository";
import { normalizeVoiceMimeType } from "@/lib/voice-input";

export const runtime = "nodejs";

export const MAX_TRANSCRIPTION_CONTEXT_CHARS = 500;
const ACCEPTED_AUDIO_TYPES = new Set([
  "audio/aac", "audio/flac", "audio/m4a", "audio/mp4", "audio/mpeg", "audio/mpga", "audio/ogg", "audio/wav", "audio/webm", "audio/x-m4a", "audio/x-wav",
]);

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  try { await assertAppAccess(); } catch { return jsonError("App access is required.", 401); }
  const profileId = await getSelectedProfile();
  if (!profileId) return jsonError("Select a profile first.", 400);
  if (!process.env.ASSEMBLYAI_API_KEY?.trim()) return jsonError("Voice transcription is not configured yet.", 503);

  try {
    const form = await request.formData();
    const audio = form.get("audio");
    if (!(audio instanceof File)) return jsonError("Record some audio first.", 400);
    if (audio.size <= 0) return jsonError("The recording was empty.", 400);
    const audioType = normalizeVoiceMimeType(audio.type);
    if (audioType && !ACCEPTED_AUDIO_TYPES.has(audioType)) return jsonError("That audio format is not supported by voice transcription.", 415);

    const contextValue = form.get("context");
    const context = typeof contextValue === "string" ? contextValue.trim().slice(0, MAX_TRANSCRIPTION_CONTEXT_CHARS) : "";
    const [memoryItems, vocabulary] = await Promise.all([
      createSupabaseMemoryStore().listItems(profileId).catch(() => []),
      createVoiceTranscriptionStore().listVocabulary(profileId).catch(() => []),
    ]);
    const keyterms = buildVoiceKeyterms(memoryItems, vocabulary);
    const contextPrompt = buildVoiceContextPrompt(memoryItems);
    const prompt = buildAssemblyPrompt([contextPrompt, context].filter(Boolean).join(" Current composer context: "));
    const provider = createAssemblyAIClient();
    const uploadUrl = await provider.uploadAudio(audio);
    const submitted = await provider.startTranscription({ audioUrl: uploadUrl, keyterms, prompt });
    try {
      const record = await createVoiceTranscriptionStore().create({ profileId, providerTranscriptId: submitted.id, vocabularyTermCount: keyterms.length });
      return NextResponse.json({ transcriptionId: record.id, status: record.status, vocabularyTermCount: record.vocabularyTermCount }, { status: 202, headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      await provider.deleteTranscription(submitted.id).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start voice transcription.";
    if (message === "ASSEMBLYAI_API_KEY is required.") return jsonError("Voice transcription is not configured yet.", 503);
    if (message.startsWith("AssemblyAI request failed with status 401")) return jsonError("The AssemblyAI key was rejected. Check ASSEMBLYAI_API_KEY.", 502);
    return jsonError("Could not start voice transcription.", 502);
  }
}
