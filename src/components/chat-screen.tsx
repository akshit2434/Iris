"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Edit3, LoaderCircle, Send, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { Message, Thread } from "@/lib/types";
import { useProfile } from "@/components/profile-provider";
import { ProfilePicker } from "@/components/profile-picker";

type ThreadResponse = { thread: Thread; messages: Message[] };
type StreamEvent =
  | { type: "start"; userMessageId: string; assistantMessageId: string }
  | { type: "delta"; text: string }
  | { type: "done"; messageId: string }
  | { type: "error"; message: string };

function formatMessageTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export function ChatScreen() {
  const params = useParams<{ threadId: string }>();
  const threadId = params.threadId;
  const { profileId, isReady } = useProfile();
  const [thread, setThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [composer, setComposer] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const activeAssistantIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!profileId || !threadId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetch(`/api/threads/${threadId}`, { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json()) as Partial<ThreadResponse> & { error?: string };
        if (!response.ok || !body.thread || !body.messages) throw new Error(body.error ?? "Could not load this chat.");
        if (!cancelled) {
          setThread(body.thread);
          setDraftTitle(body.thread.title);
          setMessages(body.messages);
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Could not load this chat.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [profileId, threadId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: sending ? "smooth" : "auto" });
  }, [messages, sending]);

  const hasMessages = messages.length > 0;

  async function saveTitle() {
    if (!thread || !draftTitle.trim()) return;
    setSavingTitle(true);
    try {
      const response = await fetch(`/api/threads/${thread.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: draftTitle }) });
      const body = (await response.json()) as { thread?: Thread; error?: string };
      if (!response.ok || !body.thread) throw new Error(body.error ?? "Could not rename this chat.");
      setThread(body.thread);
      setDraftTitle(body.thread.title);
      setEditingTitle(false);
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : "Could not rename this chat.");
    } finally {
      setSavingTitle(false);
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = composer.trim();
    if (!content || sending || !thread) return;
    setComposer("");
    setError(null);
    setSending(true);
    const optimisticUserId = `pending-user-${crypto.randomUUID()}`;
    const optimisticAssistantId = `pending-assistant-${crypto.randomUUID()}`;
    activeAssistantIdRef.current = optimisticAssistantId;
    const now = new Date().toISOString();
    setMessages((current) => [
      ...current,
      { id: optimisticUserId, threadId: thread.id, profileId: thread.profileId, role: "user", content, createdAt: now },
      { id: optimisticAssistantId, threadId: thread.id, profileId: thread.profileId, role: "assistant", content: "", createdAt: now },
    ]);

    try {
      const response = await fetch(`/api/threads/${thread.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) });
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Could not send that message.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;
      while (!done) {
        const result = await reader.read();
        done = result.done;
        buffer += decoder.decode(result.value ?? new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          handleStreamEvent(JSON.parse(line) as StreamEvent, optimisticUserId, optimisticAssistantId);
        }
      }
      if (buffer.trim()) handleStreamEvent(JSON.parse(buffer) as StreamEvent, optimisticUserId, optimisticAssistantId);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Could not send that message.");
      setMessages((current) => current.filter((message) => message.id !== optimisticAssistantId));
    } finally {
      activeAssistantIdRef.current = null;
      setSending(false);
    }
  }

  function handleStreamEvent(event: StreamEvent, optimisticUserId: string, optimisticAssistantId: string) {
    if (event.type === "start") {
      activeAssistantIdRef.current = event.assistantMessageId;
      setMessages((current) => current.map((message) => message.id === optimisticUserId ? { ...message, id: event.userMessageId } : message.id === optimisticAssistantId ? { ...message, id: event.assistantMessageId } : message));
    } else if (event.type === "delta") {
      setMessages((current) => current.map((message) => message.id === activeAssistantIdRef.current || message.id === optimisticAssistantId ? { ...message, content: message.content + event.text } : message));
    } else if (event.type === "done") {
      setMessages((current) => current.map((message) => message.id === optimisticAssistantId ? { ...message, id: event.messageId } : message));
    } else if (event.type === "error") {
      setError(event.message);
      setMessages((current) => current.filter((message) => message.id !== optimisticAssistantId && message.id !== activeAssistantIdRef.current && !message.id.startsWith("pending-assistant-")));
    }
  }

  if (!isReady) return <div className="mx-auto max-w-5xl animate-pulse p-5 sm:p-8"><div className="h-8 w-52 rounded-xl bg-white" /><div className="mt-6 h-[55vh] rounded-3xl bg-white" /></div>;
  if (!profileId) return <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-5xl items-center px-5 py-12 sm:px-8"><ProfilePicker /></div>;
  if (loading) return <div className="mx-auto max-w-5xl animate-pulse p-5 sm:p-8"><div className="h-8 w-64 rounded-xl bg-white" /><div className="mt-6 h-[55vh] rounded-3xl bg-white" /></div>;
  if (!thread) return <div className="mx-auto max-w-2xl px-5 py-16 sm:px-8"><div className="rounded-[28px] border border-red-100 bg-white p-7 text-center"><p className="text-sm font-semibold text-red-500">Chat unavailable</p><p className="mt-2 text-slate-600">{error ?? "This chat could not be found in the selected profile."}</p><Link href="/history" className="mt-5 inline-flex text-sm font-bold text-[var(--iris-accent)] hover:underline">Back to history</Link></div></div>;

  return (
    <div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-5xl flex-col px-3 sm:px-6 lg:px-8">
      <div className="flex items-center gap-3 border-b border-slate-200 px-2 py-4 sm:px-0">
        <Link href="/history" className="rounded-xl p-2 text-slate-400 transition hover:bg-white hover:text-slate-900" aria-label="Back to history"><ArrowLeft size={18} /></Link>
        <div className="min-w-0 flex-1">
          {editingTitle ? <div className="flex items-center gap-2"><input autoFocus value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void saveTitle(); if (event.key === "Escape") setEditingTitle(false); }} className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm font-semibold outline-none focus:border-[var(--iris-accent)]" /><button type="button" onClick={() => void saveTitle()} disabled={savingTitle} className="rounded-lg p-1.5 text-emerald-600 hover:bg-emerald-50"><Check size={16} /></button><button type="button" onClick={() => setEditingTitle(false)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"><X size={16} /></button></div> : <button type="button" onClick={() => setEditingTitle(true)} className="group flex max-w-full items-center gap-2 text-left"><span className="truncate text-sm font-semibold text-slate-900">{thread.title}</span><Edit3 size={13} className="shrink-0 text-slate-300 transition group-hover:text-[var(--iris-accent)]" /></button>}
        </div>
      </div>

      <div className="iris-scrollbar flex-1 overflow-y-auto py-6 sm:py-8">
        {!hasMessages ? <div className="flex min-h-[48vh] flex-col items-center justify-center rounded-[32px] bg-gradient-to-br from-[#e5f4ff] via-[#eef0ff] to-transparent px-6 text-center"><span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/75 text-[var(--iris-accent)]"><Sparkles size={24} /></span><h1 className="mt-5 text-2xl font-semibold tracking-tight text-slate-900">What would you like to think through?</h1></div> : null}
        <div className="space-y-5">
          {messages.map((message) => <MessageBubble key={message.id} message={message} />)}
          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="pb-4 pt-2 sm:pb-6">
        {error ? <p className="mb-3 rounded-xl bg-red-50 px-3 py-2 text-xs font-medium text-red-600">{error}</p> : null}
        <form onSubmit={sendMessage} className="rounded-[26px] border border-white/90 bg-white/85 p-2 shadow-[0_14px_44px_rgba(120,145,190,0.12)] transition focus-within:border-[var(--iris-accent)] focus-within:shadow-md">
          <textarea value={composer} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} rows={2} placeholder="Message Iris…" className="max-h-36 min-h-14 w-full resize-none bg-transparent px-3 py-2 text-sm leading-6 text-slate-900 outline-none placeholder:text-slate-400" disabled={sending} />
          <div className="flex justify-end px-2 pb-1"><button type="submit" disabled={!composer.trim() || sending} className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-950 text-white transition hover:-translate-y-0.5 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40" aria-label="Send message">{sending ? <LoaderCircle size={16} className="animate-spin" /> : <Send size={16} />}</button></div>
        </form>
      </div>
    </div>
  );
}

function MessageBubble({ message }: Readonly<{ message: Message }>) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`} id={`message-${message.id}`}>
      <div className={`max-w-[88%] sm:max-w-[75%] ${isUser ? "items-end" : "items-start"}`}>
        <div className={`rounded-3xl px-4 py-3 text-sm leading-6 ${isUser ? "rounded-br-md bg-slate-950 text-white" : "rounded-bl-md border border-slate-200 bg-white text-slate-700 shadow-sm"}`}>
          {message.content ? <p className="whitespace-pre-wrap">{message.content}</p> : <span className="inline-flex items-center gap-1.5 text-slate-400"><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-300 [animation-delay:-0.3s]" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-300 [animation-delay:-0.15s]" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-300" /></span>}
        </div>
        <p className={`mt-1.5 px-1 text-[11px] text-slate-400 ${isUser ? "text-right" : "text-left"}`}><span className="sr-only">{isUser ? "You" : "Iris"} · </span>{formatMessageTime(message.createdAt)}</p>
      </div>
    </div>
  );
}
