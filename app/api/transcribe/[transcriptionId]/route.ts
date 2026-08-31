import { NextResponse } from "next/server";
import { assertAppAccess } from "@/server/auth/gate";
import { getSelectedProfile } from "@/server/auth/profile";
import { createAssemblyAIClient } from "@/server/transcription/assemblyai";
import { createVoiceTranscriptionStore } from "@/server/transcription/repository";

export const runtime = "nodejs";

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(_request: Request, { params }: { params: Promise<{ transcriptionId: string }> }) {
  try { await assertAppAccess(); } catch { return jsonError("App access is required.", 401); }
  const profileId = await getSelectedProfile();
  if (!profileId) return jsonError("Select a profile first.", 400);
  if (!process.env.ASSEMBLYAI_API_KEY?.trim()) return jsonError("Voice transcription is not configured yet.", 503);

  try {
    const { transcriptionId } = await params;
    const store = createVoiceTranscriptionStore();
    const record = await store.get(profileId, transcriptionId);
    if (!record) return jsonError("Transcription not found.", 404);
    if (record.status === "completed" || record.status === "failed" || record.status === "cancelled") return NextResponse.json({ transcriptionId: record.id, status: record.status, text: record.transcript, error: record.errorMessage }, { headers: { "Cache-Control": "no-store" } });

    const provider = createAssemblyAIClient();
    const remote = await provider.getTranscription(record.providerTranscriptId);
    if (remote.status === "completed") {
      const text = remote.text?.trim() ?? "";
      if (!text) {
        const failed = await store.markStatus({ profileId, id: record.id, status: "failed", errorMessage: "The provider returned an empty transcript." });
        await provider.deleteTranscription(record.providerTranscriptId).catch(() => undefined);
        return NextResponse.json({ transcriptionId: failed.id, status: failed.status, text: null, error: failed.errorMessage }, { headers: { "Cache-Control": "no-store" } });
      }
      const completed = await store.markStatus({ profileId, id: record.id, status: "completed", transcript: text, completed: true });
      await provider.deleteTranscription(record.providerTranscriptId).catch(() => undefined);
      return NextResponse.json({ transcriptionId: completed.id, status: completed.status, text: completed.transcript, error: null }, { headers: { "Cache-Control": "no-store" } });
    }
    if (remote.status === "error") {
      const failed = await store.markStatus({ profileId, id: record.id, status: "failed", errorMessage: remote.error?.slice(0, 500) || "AssemblyAI could not transcribe that recording." });
      await provider.deleteTranscription(record.providerTranscriptId).catch(() => undefined);
      return NextResponse.json({ transcriptionId: failed.id, status: failed.status, text: null, error: failed.errorMessage }, { headers: { "Cache-Control": "no-store" } });
    }
    const updated = remote.status === "processing" && record.status !== "processing"
      ? await store.markStatus({ profileId, id: record.id, status: "processing" })
      : record;
    return NextResponse.json({ transcriptionId: updated.id, status: updated.status, text: null, error: null }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return jsonError("Could not read voice transcription status.", 502);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ transcriptionId: string }> }) {
  try { await assertAppAccess(); } catch { return jsonError("App access is required.", 401); }
  const profileId = await getSelectedProfile();
  if (!profileId) return jsonError("Select a profile first.", 400);
  if (!process.env.ASSEMBLYAI_API_KEY?.trim()) return jsonError("Voice transcription is not configured yet.", 503);

  try {
    const { transcriptionId } = await params;
    const store = createVoiceTranscriptionStore();
    const record = await store.get(profileId, transcriptionId);
    if (!record) return jsonError("Transcription not found.", 404);
    if (record.status === "completed" || record.status === "failed" || record.status === "cancelled") {
      return NextResponse.json({ transcriptionId: record.id, status: record.status }, { headers: { "Cache-Control": "no-store" } });
    }
    const provider = createAssemblyAIClient();
    const cancelled = await store.markStatus({ profileId, id: record.id, status: "cancelled", errorMessage: "Cancelled by the user." });
    await provider.deleteTranscription(record.providerTranscriptId).catch(() => undefined);
    return NextResponse.json({ transcriptionId: cancelled.id, status: cancelled.status }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return jsonError("Could not cancel voice transcription.", 502);
  }
}
