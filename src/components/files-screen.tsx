"use client";

import { useEffect, useRef, useState } from "react";
import { FluidReveal } from "@/components/fluid-reveal";
import { ProfilePicker } from "@/components/profile-picker";
import { useProfile } from "@/components/profile-provider";

type FileSummary = {
  fileId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  recordKind: "upload" | "artifact";
  createdAt: string;
};

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilesScreen() {
  const { profileId, isReady } = useProfile();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<FileSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!profileId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetch("/api/files", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { files?: FileSummary[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? "Could not load files.");
        if (!cancelled) setFiles(body.files ?? []);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load files.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [profileId]);

  async function uploadSelectedFile(file: File) {
    setUploading(true);
    setError(null);
    const form = new FormData();
    form.set("file", file);
    try {
      const response = await fetch("/api/files", { method: "POST", body: form });
      const body = await response.json() as { file?: FileSummary; error?: string };
      if (!response.ok || !body.file) throw new Error(body.error ?? "Could not upload that file.");
      setFiles((current) => [body.file!, ...current]);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not upload that file.");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function openFile(fileId: string) {
    setError(null);
    try {
      const response = await fetch(`/api/files/${fileId}`, { cache: "no-store" });
      const body = await response.json() as { downloadUrl?: string; error?: string };
      if (!response.ok || !body.downloadUrl) throw new Error(body.error ?? "Could not open that file.");
      window.open(body.downloadUrl, "_blank", "noopener,noreferrer");
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not open that file.");
    }
  }

  if (!isReady) return null;
  if (!profileId) return <div className="mx-auto flex min-h-[calc(100dvh-4rem)] max-w-4xl items-center px-5 py-12"><ProfilePicker /></div>;

  return <FluidReveal className="relative mx-auto min-h-[calc(100dvh-4rem)] w-full max-w-4xl px-5 pb-8 pt-12 sm:px-9 sm:pt-20">
    <div className="ambient-orb -right-56 -top-40" />
    <div className="relative mx-auto max-w-3xl">
      <div data-reveal className="flex flex-wrap items-end justify-between gap-5">
        <div><h1 className="text-[clamp(2.8rem,10vw,5.4rem)] font-medium leading-none tracking-[-.06em]">Files</h1><p className="mt-4 max-w-md text-sm leading-6 text-slate-500">Private to the selected profile. Iris can search names, read plain text, and prepare temporary links for original files.</p></div>
        <div>
          <input ref={inputRef} type="file" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadSelectedFile(file); }} />
          <button type="button" disabled={uploading} onClick={() => inputRef.current?.click()} className="soft-press flex h-12 w-12 items-center justify-center rounded-2xl bg-[#243d79] text-white shadow-[0_12px_24px_rgba(36,61,121,.22)] disabled:opacity-50" aria-label="Upload file" title="Upload file">{uploading ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/35 border-t-white" /> : <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" aria-hidden="true"><path d="M12 15V3m0 0L7.5 7.5M12 3l4.5 4.5M5 14.5v4.2A2.3 2.3 0 0 0 7.3 21h9.4a2.3 2.3 0 0 0 2.3-2.3v-4.2" /></svg>}</button>
        </div>
      </div>
      {error ? <p data-reveal className="mt-6 rounded-2xl border border-red-200/80 bg-red-50/70 px-4 py-3 text-sm font-medium text-red-700">{error}</p> : null}
      <div data-reveal className="mt-10 rounded-[34px] border border-white/64 bg-white/30 p-3 backdrop-blur-xl sm:p-5">
        {loading ? <p className="px-3 py-12 text-center text-sm text-slate-500">Loading files…</p> : files.length === 0 ? <div className="px-6 py-14 text-center"><div className="mx-auto h-16 w-14 rounded-[18px] border border-white/90 bg-gradient-to-br from-white/90 to-[#e5edff]/70 shadow-[0_16px_30px_rgba(85,108,150,.12)]"><span className="mx-auto mt-4 block h-1 w-6 rounded-full bg-[#90a8e8]/45" /><span className="mx-auto mt-2 block h-1 w-8 rounded-full bg-[#90a8e8]/25" /></div><h2 className="mt-6 text-lg font-semibold tracking-tight">Nothing here yet.</h2><p className="mt-2 text-sm text-slate-500">Upload a source file to give Iris something concrete to work with.</p></div> : <div className="space-y-2">{files.map((file) => <div key={file.fileId} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white/45 px-4 py-4"><div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-800">{file.name}</p><p className="mt-1 text-xs text-slate-500">{formatSize(file.sizeBytes)} · {file.mimeType} · {new Date(file.createdAt).toLocaleDateString()}</p></div><button type="button" onClick={() => void openFile(file.fileId)} className="soft-press flex h-9 w-9 items-center justify-center rounded-xl border border-[#bfcdf1] bg-white/70 text-[#416fd8]" aria-label={`Open ${file.name}`} title="Open file"><svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.35" aria-hidden="true"><path d="M5 3.5h7.5V11M12.2 3.8 4 12" /></svg></button></div>)}</div>}
      </div>
    </div>
  </FluidReveal>;
}
