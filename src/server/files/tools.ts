import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";
import type { AgentContext } from "@/server/agent/context";
import {
  createFileRepository,
  fileSummary,
  type FileRepository,
  type FileRecordKind,
} from "@/server/files/repository";

const listInput = z.object({ limit: z.number().int().min(1).max(20).default(10) });
const searchInput = z.object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(20).default(10) });
const fileInput = z.object({ fileId: z.string().uuid() });
const readInput = fileInput.extend({ maxChars: z.number().int().min(1_000).max(200_000).default(50_000) });

type FileToolRuntime = ToolRuntime<unknown, AgentContext>;

function errorResult(kind: string, message: string) {
  return { kind, status: "error" as const, message };
}

async function listFiles(context: AgentContext, repository: FileRepository, kind?: FileRecordKind, query?: string, limit = 10) {
  const files = await repository.list(context.profileId, { kind, query, limit });
  return { files: files.map(fileSummary), count: files.length };
}

async function openFile(context: AgentContext, repository: FileRepository, fileId: string, kind?: FileRecordKind) {
  const record = await repository.get(context.profileId, fileId, kind);
  if (!record) return errorResult(kind === "artifact" ? "artifact_open" : "file_open", "That file is not available in the current profile.");
  const downloadUrl = await repository.createSignedUrl(record);
  return { kind: kind === "artifact" ? "artifact_open" as const : "file_open" as const, status: "ready" as const, file: fileSummary(record), downloadUrl };
}

export function createFileTools(repository?: FileRepository) {
  let resolved = repository;
  const getRepository = () => {
    resolved ??= createFileRepository();
    return resolved;
  };

  const fileList = tool(
    async (input: z.infer<typeof listInput>, runtime: FileToolRuntime) => ({ kind: "file_list" as const, ...(await listFiles(runtime.context, getRepository(), "upload", undefined, input.limit)) }),
    {
      name: "file_list",
      description: "List uploaded files in the current profile. Use when the user asks what files are available; do not infer files that are not returned.",
      schema: listInput,
    },
  );
  const fileSearch = tool(
    async (input: z.infer<typeof searchInput>, runtime: FileToolRuntime) => ({ kind: "file_search" as const, query: input.query, ...(await listFiles(runtime.context, getRepository(), "upload", input.query, input.limit)) }),
    {
      name: "file_search",
      description: "Search uploaded file names in the current profile. Use a concrete file name or subject; use file_open for a downloadable source and file_read for text content.",
      schema: searchInput,
    },
  );
  const fileRead = tool(
    async (input: z.infer<typeof readInput>, runtime: FileToolRuntime) => {
      const repositoryInstance = getRepository();
      const record = await repositoryInstance.get(runtime.context.profileId, input.fileId, "upload");
      if (!record) return errorResult("file_read", "That file is not available in the current profile.");
      const result = await repositoryInstance.readText(record, input.maxChars);
      if (!result) return { kind: "file_read" as const, status: "unsupported" as const, file: fileSummary(record), message: "This file is not plain text. Use file_open to access the original download." };
      return { kind: "file_read" as const, status: "ok" as const, file: fileSummary(record), text: result.text, truncated: result.truncated };
    },
    {
      name: "file_read",
      description: "Read a bounded amount of plain-text content from one uploaded file in the current profile. For PDFs, documents, slides, images, and other binary files, use file_open instead and do not pretend to have parsed them.",
      schema: readInput,
    },
  );
  const fileOpen = tool(
    async (input: z.infer<typeof fileInput>, runtime: FileToolRuntime) => openFile(runtime.context, getRepository(), input.fileId, "upload"),
    {
      name: "file_open",
      description: "Prepare a temporary download URL for one uploaded file in the current profile. This does not mean the file was opened or displayed to the user.",
      schema: fileInput,
    },
  );
  const artifactList = tool(
    async (input: z.infer<typeof listInput>, runtime: FileToolRuntime) => ({ kind: "artifact_list" as const, ...(await listFiles(runtime.context, getRepository(), "artifact", undefined, input.limit)) }),
    {
      name: "artifact_list",
      description: "List generated artifacts associated with the current profile. Do not claim an artifact exists unless it is returned here.",
      schema: listInput,
    },
  );
  const artifactOpen = tool(
    async (input: z.infer<typeof fileInput>, runtime: FileToolRuntime) => openFile(runtime.context, getRepository(), input.fileId, "artifact"),
    {
      name: "artifact_open",
      description: "Prepare a temporary download URL for one generated artifact in the current profile.",
      schema: fileInput,
    },
  );

  return [fileList, fileSearch, fileRead, fileOpen, artifactList, artifactOpen] as const;
}
