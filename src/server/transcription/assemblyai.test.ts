import { describe, expect, it, vi } from "vitest";
import { createAssemblyAIClient } from "@/server/transcription/assemblyai";

describe("AssemblyAI transcription client", () => {
  it("uploads, submits, polls, and deletes without exposing the key to callers", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ upload_url: "https://assembly.test/upload/1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "transcript-1", status: "queued" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "transcript-1", status: "completed", text: "नमस्ते Neyven" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const client = createAssemblyAIClient({ apiKey: "test-key", fetchImpl, baseUrl: "https://assembly.test" });
    const file = new File(["audio"], "voice.webm", { type: "audio/webm" });

    await expect(client.uploadAudio(file)).resolves.toBe("https://assembly.test/upload/1");
    await expect(client.startTranscription({ audioUrl: "https://assembly.test/upload/1", keyterms: ["Neyven"], prompt: "Hindi and English" })).resolves.toEqual({ id: "transcript-1", status: "queued" });
    await expect(client.getTranscription("transcript-1")).resolves.toMatchObject({ status: "completed", text: "नमस्ते Neyven" });
    await expect(client.deleteTranscription("transcript-1")).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ headers: { authorization: "test-key", "content-type": "application/json" } });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({
      speech_models: ["universal-3-5-pro", "universal-2"],
      keyterms_prompt: ["Neyven"],
    });
  });

  it("fails clearly when the key is missing", () => {
    expect(() => createAssemblyAIClient({ apiKey: "" })).toThrow("ASSEMBLYAI_API_KEY is required.");
  });
});
