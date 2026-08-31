import "server-only";

const ASSEMBLYAI_BASE_URL = "https://api.assemblyai.com";

export type AssemblyAIStatus = "queued" | "processing" | "completed" | "error";

export type AssemblyAITranscription = {
  id: string;
  status: AssemblyAIStatus;
  text?: string | null;
  error?: string | null;
};

export type AssemblyAIClient = {
  uploadAudio: (file: File) => Promise<string>;
  startTranscription: (input: { audioUrl: string; keyterms: readonly string[]; prompt: string }) => Promise<{ id: string; status: AssemblyAIStatus }>;
  getTranscription: (providerTranscriptId: string) => Promise<AssemblyAITranscription>;
  deleteTranscription: (providerTranscriptId: string) => Promise<void>;
};

type AssemblyAIDependencies = { apiKey?: string; fetchImpl?: typeof fetch; baseUrl?: string };

function requireApiKey(value: string | undefined) {
  const apiKey = value ?? process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey?.trim()) throw new Error("ASSEMBLYAI_API_KEY is required.");
  return apiKey.trim();
}

async function readError(response: Response) {
  const body = await response.text().catch(() => "");
  const detail = body.match(/"(?:error|message)"\s*:\s*"([^"]+)/i)?.[1];
  return detail ? `AssemblyAI request failed: ${detail.slice(0, 240)}` : `AssemblyAI request failed with status ${response.status}.`;
}

function parseStatus(value: unknown): AssemblyAIStatus {
  return value === "queued" || value === "processing" || value === "completed" || value === "error" ? value : "error";
}

export function createAssemblyAIClient(dependencies: AssemblyAIDependencies = {}): AssemblyAIClient {
  const apiKey = requireApiKey(dependencies.apiKey);
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const baseUrl = dependencies.baseUrl ?? ASSEMBLYAI_BASE_URL;
  const headers = { authorization: apiKey };

  return {
    async uploadAudio(file) {
      const response = await fetchImpl(`${baseUrl}/v2/upload`, { method: "POST", headers, body: file });
      if (!response.ok) throw new Error(await readError(response));
      const body = (await response.json()) as { upload_url?: unknown };
      if (typeof body.upload_url !== "string" || !body.upload_url) throw new Error("AssemblyAI did not return an upload URL.");
      return body.upload_url;
    },

    async startTranscription(input) {
      const response = await fetchImpl(`${baseUrl}/v2/transcript`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          audio_url: input.audioUrl,
          speech_models: ["universal-3-5-pro", "universal-2"],
          language_detection: true,
          language_detection_options: { code_switching: true },
          keyterms_prompt: input.keyterms.slice(0, 1000),
          prompt: input.prompt,
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const body = (await response.json()) as { id?: unknown; status?: unknown };
      if (typeof body.id !== "string" || !body.id) throw new Error("AssemblyAI did not return a transcript ID.");
      return { id: body.id, status: parseStatus(body.status) };
    },

    async getTranscription(providerTranscriptId) {
      const response = await fetchImpl(`${baseUrl}/v2/transcript/${encodeURIComponent(providerTranscriptId)}`, { headers });
      if (!response.ok) throw new Error(await readError(response));
      const body = (await response.json()) as { id?: unknown; status?: unknown; text?: unknown; error?: unknown };
      return {
        id: typeof body.id === "string" ? body.id : providerTranscriptId,
        status: parseStatus(body.status),
        text: typeof body.text === "string" ? body.text : null,
        error: typeof body.error === "string" ? body.error : null,
      };
    },

    async deleteTranscription(providerTranscriptId) {
      const response = await fetchImpl(`${baseUrl}/v2/transcript/${encodeURIComponent(providerTranscriptId)}`, { method: "DELETE", headers });
      if (!response.ok && response.status !== 404) throw new Error(await readError(response));
    },
  };
}
