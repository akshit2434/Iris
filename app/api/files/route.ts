import { NextResponse } from "next/server";
import { assertAppAccess } from "@/server/auth/gate";
import { getSelectedProfile } from "@/server/auth/profile";
import { createFileRepository, MAX_FILE_BYTES, fileSummary } from "@/server/files/repository";

export const runtime = "nodejs";

async function requireProfile() {
  const profileId = await getSelectedProfile();
  if (!profileId) throw new Error("Select a profile first.");
  return profileId;
}

export async function GET(request: Request) {
  try {
    await assertAppAccess();
  } catch {
    return NextResponse.json({ error: "App access is required." }, { status: 401 });
  }
  try {
    const profileId = await requireProfile();
    const url = new URL(request.url);
    const query = url.searchParams.get("q")?.trim() || undefined;
    const kind = url.searchParams.get("kind") === "artifact" ? "artifact" as const : "upload" as const;
    const files = await createFileRepository().list(profileId, { query, kind, limit: 100 });
    return NextResponse.json({ profileId, files: files.map(fileSummary) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof Error && error.message === "Select a profile first.") return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "Could not load files." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    await assertAppAccess();
  } catch {
    return NextResponse.json({ error: "App access is required." }, { status: 401 });
  }
  try {
    const profileId = await requireProfile();
    const form = await request.formData();
    const value = form.get("file");
    if (!(value instanceof File)) return NextResponse.json({ error: "Choose a file to upload." }, { status: 400 });
    if (value.size > MAX_FILE_BYTES) return NextResponse.json({ error: "Files must be 50 MiB or smaller." }, { status: 413 });
    const bytes = await value.arrayBuffer();
    const record = await createFileRepository().upload({
      profileId,
      fileId: crypto.randomUUID(),
      name: value.name,
      mimeType: value.type || "application/octet-stream",
      bytes,
    });
    return NextResponse.json({ profileId, file: fileSummary(record) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof Error && error.message === "Select a profile first.") return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "Could not upload that file." }, { status: 500 });
  }
}
