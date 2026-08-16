"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AssistantMarkdown } from "@/components/assistant-markdown";
import { FluidReveal } from "@/components/fluid-reveal";
import { ProfilePicker } from "@/components/profile-picker";
import { useProfile } from "@/components/profile-provider";
import { buildOpenMessageHref } from "@/lib/memory-source";

type MemorySummary = {
  canonicalKey: string;
  itemRevision: number;
  category: string;
  origin: string;
  updatedAt: string;
  status: string;
  excerpt: string;
};

type MemoryDetail = {
  canonicalKey: string;
  content: string;
  itemRevision: number;
  category: string;
  origin: string;
  status: string;
  updatedAt: string;
  revisions: Array<{
    itemRevision: number;
    profileGlobalRevision: number;
    mutationKind: string;
    createdAt: string;
    content: string;
    sources: Array<{
      sourceKind: string;
      sourceThreadId: string | null;
      sourceMessageId: string | null;
      sourceAgentEventId: string | null;
      sourceAgentRunId: string | null;
      sourceExcerpt: string | null;
      metadata: Record<string, unknown>;
      createdAt: string;
      action?: { type: "open_message"; threadId: string; messageId: string; label: string };
    }>;
  }>;
};

function formatDate(value: string) {
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); } catch { return value; }
}

type MemoryControls = { savedMemoryEnabled: boolean; referenceHistoryEnabled: boolean; updatedAt: string };

const CATEGORY_LABELS: Record<string, string> = {
  instruction: "Instructions",
  preference: "Preferences",
  personal_fact: "Facts",
  active_state: "Current context",
  project: "Projects and goals",
  goal: "Projects and goals",
  relationship: "Relationships",
  pattern: "Patterns",
  other: "Other",
};

function categoryLabel(category: string) { return CATEGORY_LABELS[category] ?? "Other"; }
function originLabel(origin: string) { return origin === "explicit" ? "Explicit" : origin === "inferred" ? "Automatic" : "System"; }

export function MemoryScreen() {
  const { profileId, isReady } = useProfile();
  const searchParams = useSearchParams();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [globalRevision, setGlobalRevision] = useState(0);
  const [items, setItems] = useState<MemorySummary[]>([]);
  const [details, setDetails] = useState<Record<string, MemoryDetail>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [controls, setControls] = useState<MemoryControls | null>(null);
  const [savingControl, setSavingControl] = useState<"saved" | "reference" | null>(null);
  const [clearing, setClearing] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draftContent, setDraftContent] = useState("");
  const [savingItem, setSavingItem] = useState<string | null>(null);

  const loadMemoryItems = useCallback(async (archived: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/memory${archived ? "?archived=true" : ""}`, { cache: "no-store" });
      const body = (await response.json()) as { globalRevision?: number; items?: MemorySummary[]; error?: string };
      if (!response.ok || !body.items) throw new Error(body.error ?? "Could not load memory.");
      setGlobalRevision(body.globalRevision ?? 0);
      setItems(body.items);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load memory.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (profileId) void loadMemoryItems(includeArchived); }, [includeArchived, loadMemoryItems, profileId]);

  useEffect(() => {
    if (!profileId) return;
    void fetch("/api/memory/settings", { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json()) as { controls?: MemoryControls; error?: string };
        if (!response.ok || !body.controls) throw new Error(body.error ?? "Could not load memory settings.");
        setControls(body.controls);
      })
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : "Could not load memory settings."));
  }, [profileId]);

  useEffect(() => {
    const requestedKey = searchParams.get("item");
    if (requestedKey && items.some((item) => item.canonicalKey === requestedKey)) setExpanded(requestedKey);
  }, [items, searchParams]);

  useEffect(() => {
    if (!expanded || details[expanded]) return;
    void loadItemDetail(expanded);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  async function toggleItem(canonicalKey: string) {
    if (expanded === canonicalKey) { setExpanded(null); return; }
    setExpanded(canonicalKey);
    if (details[canonicalKey]) return;
    await loadItemDetail(canonicalKey);
  }

  async function loadItemDetail(canonicalKey: string) {
    try {
      const response = await fetch(`/api/memory?canonicalKey=${encodeURIComponent(canonicalKey)}${includeArchived ? "&archived=true" : ""}`, { cache: "no-store" });
      const body = (await response.json()) as { item?: MemoryDetail; error?: string };
      if (!response.ok || !body.item) throw new Error(body.error ?? "Could not load this memory.");
      setDetails((current) => ({ ...current, [canonicalKey]: body.item! }));
    } catch (detailError) {
      setError(detailError instanceof Error ? detailError.message : "Could not load this memory.");
    }
  }

  async function updateControl(kind: "saved" | "reference", enabled: boolean) {
    setSavingControl(kind);
    try {
      const response = await fetch("/api/memory/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(kind === "saved" ? { savedMemoryEnabled: enabled } : { referenceHistoryEnabled: enabled }) });
      const body = (await response.json()) as { controls?: MemoryControls; error?: string };
      if (!response.ok || !body.controls) throw new Error(body.error ?? "Could not update memory settings.");
      setControls(body.controls);
    } catch (controlError) {
      setError(controlError instanceof Error ? controlError.message : "Could not update memory settings.");
    } finally { setSavingControl(null); }
  }

  async function saveCorrection(detail: MemoryDetail) {
    if (!draftContent.trim() || draftContent.trim() === detail.content) { setEditingKey(null); return; }
    setSavingItem(detail.canonicalKey);
    try {
      const response = await fetch("/api/memory", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "update", canonicalKey: detail.canonicalKey, expectedItemRevision: detail.itemRevision, content: draftContent.trim() }) });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not correct memory.");
      setEditingKey(null);
      setDetails((current) => { const existing = current[detail.canonicalKey]; return existing ? { ...current, [detail.canonicalKey]: { ...existing, content: draftContent.trim(), itemRevision: existing.itemRevision + 1, updatedAt: new Date().toISOString(), origin: "explicit" } } : current; });
      await loadMemoryItems(includeArchived);
      await loadItemDetail(detail.canonicalKey);
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "Could not correct memory."); }
    finally { setSavingItem(null); }
  }

  async function forgetMemory(detail: MemoryDetail) {
    if (!window.confirm("Forget this memory? The raw chat stays saved.")) return;
    setSavingItem(detail.canonicalKey);
    try {
      const response = await fetch("/api/memory", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "archive", canonicalKey: detail.canonicalKey, expectedItemRevision: detail.itemRevision, reason: "User forgot this memory." }) });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not forget memory.");
      setExpanded(null);
      setDetails((current) => { const next = { ...current }; delete next[detail.canonicalKey]; return next; });
      await loadMemoryItems(includeArchived);
    } catch (forgetError) { setError(forgetError instanceof Error ? forgetError.message : "Could not forget memory."); }
    finally { setSavingItem(null); }
  }

  async function clearAllMemory() {
    if (!window.confirm("Remove all saved memory and derived reference history? Raw chats will remain saved.")) return;
    setClearing(true);
    try {
      const response = await fetch("/api/memory", { method: "DELETE" });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not clear memory.");
      setExpanded(null); setDetails({});
      await loadMemoryItems(includeArchived);
    } catch (clearError) { setError(clearError instanceof Error ? clearError.message : "Could not clear memory."); }
    finally { setClearing(false); }
  }

  const groupedItems = useMemo(() => {
    const groups = new Map<string, MemorySummary[]>();
    for (const item of items) groups.set(categoryLabel(item.category), [...(groups.get(categoryLabel(item.category)) ?? []), item]);
    return [...groups.entries()];
  }, [items]);

  if (!isReady) return null;
  if (!profileId) return <div className="mx-auto flex min-h-[calc(100dvh-4rem)] max-w-4xl items-center px-5 py-12"><ProfilePicker /></div>;

  return <FluidReveal className="relative mx-auto min-h-[calc(100dvh-4rem)] w-full max-w-5xl px-5 pb-10 pt-12 sm:px-9 sm:pt-20">
    <div className="ambient-orb -right-56 -top-40" />
    <div className="relative mx-auto max-w-4xl">
      <div data-reveal className="flex flex-wrap items-end justify-between gap-5">
        <div><p className="text-sm font-medium text-slate-500">A quiet record of what Iris has been asked to retain.</p><h1 className="mt-2 text-[clamp(2.8rem,10vw,5.4rem)] font-medium leading-none tracking-[-.06em]">Memory</h1></div>
        <div className="text-right text-xs font-medium text-slate-400"><p>Profile-scoped</p><p className="mt-1">Revision {globalRevision}</p></div>
      </div>
      <section data-reveal className="glass-surface mt-10 rounded-[28px] p-5 sm:p-6" aria-labelledby="memory-controls-heading">
        <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 id="memory-controls-heading" className="font-semibold tracking-tight text-slate-900">Memory controls</h2><p className="mt-1 max-w-xl text-sm leading-6 text-slate-500">These settings affect only {profileId === "profile-a" ? "this profile" : "this space"}. Turning a layer off keeps existing data but stops Iris from using or writing it.</p></div><button type="button" onClick={() => void clearAllMemory()} disabled={clearing} className="rounded-xl px-3 py-2 text-xs font-semibold text-red-500 transition hover:bg-red-50/80 disabled:opacity-50">{clearing ? "Clearing…" : "Remove all memory"}</button></div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <MemoryToggle label="Saved memory" description="Durable facts, preferences, and instructions." enabled={controls?.savedMemoryEnabled ?? true} disabled={!controls || savingControl === "saved"} onChange={(enabled) => void updateControl("saved", enabled)} />
          <MemoryToggle label="Reference chat history" description="Derived context from older chats." enabled={controls?.referenceHistoryEnabled ?? true} disabled={!controls || savingControl === "reference"} onChange={(enabled) => void updateControl("reference", enabled)} />
        </div>
        <p className="mt-4 text-xs leading-5 text-slate-400">Forgetting an item removes it from active memory and suppresses it from automatic recreation. Raw chats remain saved.</p>
      </section>
      <div data-reveal className="mt-8 flex items-center justify-between gap-4">
        <p className="text-sm text-slate-500">A small, editable profile of what Iris can carry forward.</p>
        <label className="flex shrink-0 items-center gap-2 text-xs font-semibold text-slate-600"><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} /> Show archived</label>
      </div>
      {error ? <p className="mt-4 rounded-2xl bg-red-50/80 px-4 py-3 text-sm font-medium text-red-600" role="alert">{error}</p> : null}
      <section data-reveal className="mt-6 space-y-3" aria-label="Saved memory items" aria-busy={loading}>
        {items.length === 0 && !loading ? <div className="glass-surface rounded-[28px] p-7 text-sm text-slate-500">{includeArchived ? "No archived memory items." : "No saved memory yet."}</div> : null}
        {groupedItems.map(([group, groupItems]) => <div key={group} className="space-y-3"><h2 className="px-1 text-xs font-semibold uppercase tracking-[.14em] text-slate-400">{group}</h2>{groupItems.map((item) => {
          const detail = details[item.canonicalKey];
          const isExpanded = expanded === item.canonicalKey;
          return <article key={item.canonicalKey} className={`glass-surface overflow-hidden rounded-[26px] transition-shadow ${isExpanded ? "shadow-[0_22px_60px_rgba(81,104,151,.16)]" : ""}`}>
            <button type="button" onClick={() => void toggleItem(item.canonicalKey)} aria-expanded={isExpanded} className="flex w-full items-start justify-between gap-4 p-5 text-left sm:p-6">
              <span className="min-w-0"><span className="block truncate font-semibold tracking-tight text-slate-900">{item.excerpt}</span><span className="mt-1 block text-xs font-medium text-slate-400">{originLabel(item.origin)} · updated {formatDate(item.updatedAt)}</span></span>
              <span className="flex shrink-0 items-center gap-2 text-xs font-medium text-slate-400">r{item.itemRevision}<svg viewBox="0 0 16 16" className={`h-4 w-4 transition-transform motion-reduce:transition-none ${isExpanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></span>
            </button>
            {isExpanded ? <div className="border-t border-white/70 px-5 pb-6 pt-5 sm:px-6">{detail ? <MemoryDetailView detail={detail} editing={editingKey === detail.canonicalKey} draftContent={editingKey === detail.canonicalKey ? draftContent : detail.content} saving={savingItem === detail.canonicalKey} onStartEdit={() => { setEditingKey(detail.canonicalKey); setDraftContent(detail.content); }} onDraftChange={setDraftContent} onCancelEdit={() => setEditingKey(null)} onSave={() => void saveCorrection(detail)} onForget={() => void forgetMemory(detail)} /> : <p className="text-sm text-slate-400">Loading item…</p>}</div> : null}
          </article>;
        })}</div>)}
      </section>
    </div>
  </FluidReveal>;
}

function MemoryToggle({ label, description, enabled, disabled, onChange }: Readonly<{ label: string; description: string; enabled: boolean; disabled: boolean; onChange: (enabled: boolean) => void }>) {
  return <label className={`flex cursor-pointer items-center justify-between gap-4 rounded-2xl bg-white/42 px-4 py-3 transition ${disabled ? "opacity-55" : "hover:bg-white/62"}`}>
    <span className="min-w-0"><span className="block text-sm font-semibold text-slate-800">{label}</span><span className="mt-0.5 block text-xs leading-5 text-slate-500">{description}</span></span>
    <span className={`relative h-6 w-11 shrink-0 rounded-full p-1 transition-colors ${enabled ? "bg-[#4978ed]" : "bg-slate-300/80"}`}><input type="checkbox" className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-default" checked={enabled} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /><span className={`block h-4 w-4 rounded-full bg-white shadow-sm transition-transform peer-focus-visible:ring-2 peer-focus-visible:ring-[#4978ed]/45 ${enabled ? "translate-x-5" : "translate-x-0"}`} /></span>
  </label>;
}

function MemoryDetailView({ detail, editing, draftContent, saving, onStartEdit, onDraftChange, onCancelEdit, onSave, onForget }: Readonly<{ detail: MemoryDetail; editing: boolean; draftContent: string; saving: boolean; onStartEdit: () => void; onDraftChange: (value: string) => void; onCancelEdit: () => void; onSave: () => void; onForget: () => void }>) {
  return <div>
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400"><span>{originLabel(detail.origin)} · {detail.status} · updated {formatDate(detail.updatedAt)}</span><span>{detail.revisions.length} revision{detail.revisions.length === 1 ? "" : "s"}</span></div>
    {editing ? <div className="mt-5"><textarea value={draftContent} onChange={(event) => onDraftChange(event.target.value)} rows={5} maxLength={20_000} className="w-full resize-y rounded-2xl border border-white/80 bg-white/55 px-4 py-3 text-[15px] leading-7 text-slate-700" aria-label="Correct memory" /><div className="mt-3 flex flex-wrap justify-end gap-2"><button type="button" onClick={onCancelEdit} disabled={saving} className="rounded-xl px-3 py-2 text-xs font-semibold text-slate-500">Cancel</button><button type="button" onClick={onSave} disabled={saving || !draftContent.trim()} className="rounded-xl bg-[#111827] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{saving ? "Saving…" : "Save correction"}</button></div></div> : <div className="mt-5 text-[15px] text-slate-700"><AssistantMarkdown content={detail.content} live={false} terminal /></div>}
    {!editing && detail.status === "active" ? <div className="mt-5 flex flex-wrap gap-2"><button type="button" onClick={onStartEdit} className="rounded-xl bg-white/62 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:bg-white/85">Correct</button><button type="button" onClick={onForget} disabled={saving} className="rounded-xl px-3 py-2 text-xs font-semibold text-red-500 transition hover:bg-red-50/80 disabled:opacity-50">Forget</button></div> : null}
    <div className="mt-8 space-y-3"><h2 className="text-xs font-semibold uppercase tracking-[.14em] text-slate-400">Provenance</h2>{detail.revisions.map((revision) => <div key={`${detail.canonicalKey}-${revision.itemRevision}`} className="rounded-2xl bg-white/42 px-4 py-3"><div className="flex flex-wrap justify-between gap-2 text-xs font-medium text-slate-500"><span>Revision {revision.itemRevision} · {revision.mutationKind}</span><span>{formatDate(revision.createdAt)}</span></div>{revision.sources.map((source, index) => <div key={`${revision.itemRevision}-${source.createdAt}-${index}`} className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600"><span>{source.sourceExcerpt || `Source: ${source.sourceKind}`}</span>{source.action ? <Link className="font-semibold text-[#416fd8]" href={buildOpenMessageHref(source.action) ?? "#"}>{source.action.label}</Link> : null}</div>)}</div>)}</div>
  </div>;
}
