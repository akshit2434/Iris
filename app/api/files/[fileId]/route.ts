import { NextResponse } from "next/server";
import { assertAppAccess } from "@/server/auth/gate";
import { getSelectedProfile } from "@/server/auth/profile";
import { createFileRepository, fileSummary } from "@/server/files/repository";

export const runtime = "nodejs";

type FileRouteContext = { params: Promise<{ fileId: string }> };

export async function GET(_request: Request, { params }: FileRouteContext) {
  try {
    await assertAppAccess();
  } catch {
    return NextResponse.json({ error: "App access is required." }, { status: 401 });
  }
  try {
    const profileId = await getSelectedProfile();
    if (!profileId) return NextResponse.json({ error: "Select a profile first." }, { status: 400 });
    const { fileId } = await params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(fileId)) {
      return NextResponse.json({ error: "File ID is invalid." }, { status: 400 });
    }
    const repository = createFileRepository();
    const record = await repository.get(profileId, fileId);
    if (!record) return NextResponse.json({ error: "File not found." }, { status: 404 });
    const downloadUrl = await repository.createSignedUrl(record);
    return NextResponse.json({ file: fileSummary(record), downloadUrl }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not open that file." }, { status: 500 });
  }
}
