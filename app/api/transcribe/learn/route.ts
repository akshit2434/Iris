import { NextResponse } from "next/server";
import { assertAppAccess } from "@/server/auth/gate";
import { getSelectedProfile } from "@/server/auth/profile";
import { extractVocabularyCorrections } from "@/server/transcription/context";
import { createVoiceTranscriptionStore } from "@/server/transcription/repository";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try { await assertAppAccess(); } catch { return NextResponse.json({ error: "App access is required." }, { status: 401 }); }
  const profileId = await getSelectedProfile();
  if (!profileId) return NextResponse.json({ error: "Select a profile first." }, { status: 400 });
  try {
    const body = (await request.json().catch(() => null)) as { original?: unknown; corrected?: unknown } | null;
    const original = typeof body?.original === "string" ? body.original.slice(0, 20_000) : "";
    const corrected = typeof body?.corrected === "string" ? body.corrected.slice(0, 20_000) : "";
    if (!original || !corrected || original === corrected) return NextResponse.json({ learned: 0, terms: [] }, { headers: { "Cache-Control": "no-store" } });
    const terms = extractVocabularyCorrections(original, corrected);
    if (terms.length === 0) return NextResponse.json({ learned: 0, terms }, { headers: { "Cache-Control": "no-store" } });
    const learned = await createVoiceTranscriptionStore().learnVocabulary({ profileId, terms });
    return NextResponse.json({ learned: learned.length, terms: learned.map((entry) => entry.term) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not learn those voice terms." }, { status: 500 });
  }
}
