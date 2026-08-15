"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { Message, Thread } from "@/lib/types";
import { IrisMark } from "@/components/iris-mark";
import { ProceduralBlur } from "@/components/procedural-blur";
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

  if (!isReady) return <ChatSkeleton />;
  if (!profileId) return <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-5xl items-center px-5 py-12 sm:px-8"><ProfilePicker /></div>;
  if (loading) return <ChatSkeleton />;
  if (!thread) return <div className="mx-auto flex min-h-dvh max-w-xl items-center px-5"><div className="glass-surface w-full rounded-[28px] p-7 text-center"><p className="text-sm font-semibold text-red-500">Chat unavailable</p><p className="mt-2 text-sm text-slate-500">{error ?? "This chat could not be found in the selected profile."}</p><Link href="/history" className="mt-5 inline-flex text-sm font-semibold text-[#4978ed]">Back</Link></div></div>;

  return (
    <div className="relative mx-auto flex h-dvh w-full max-w-5xl flex-col overflow-hidden">
      <header className="absolute inset-x-0 top-0 z-20 h-28">
        <ProceduralBlur edge="top" />
        <div className="relative flex h-[72px] items-center gap-3 px-4 pt-[env(safe-area-inset-top)] sm:px-7">
          <Link href="/history" className="soft-press flex h-10 w-10 shrink-0 items-center justify-center rounded-[16px] bg-white/58 text-xl font-light text-slate-700 shadow-[inset_0_0_0_1px_rgba(255,255,255,.8)] backdrop-blur-xl" aria-label="Back to history">←</Link>
          <div className="min-w-0 flex-1">
            {editingTitle ? <div className="flex items-center gap-2"><input autoFocus value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void saveTitle(); if (event.key === "Escape") setEditingTitle(false); }} className="min-w-0 flex-1 rounded-xl bg-white/65 px-3 py-2 text-sm font-semibold outline-none backdrop-blur-xl" /><button type="button" onClick={() => void saveTitle()} disabled={savingTitle} className="rounded-xl bg-[#111827] px-3 py-2 text-xs font-semibold text-white">{savingTitle ? "…" : "Save"}</button><button type="button" onClick={() => setEditingTitle(false)} className="px-2 py-2 text-xs font-semibold text-slate-500">Cancel</button></div> : <button type="button" onClick={() => setEditingTitle(true)} className="max-w-full truncate text-left text-sm font-semibold tracking-tight text-slate-800">{thread.title}</button>}
          </div>
          <IrisMark size={34} />
        </div>
      </header>

      <div className="iris-scrollbar flex-1 overflow-y-auto px-4 pb-40 pt-28 sm:px-8 sm:pb-44 sm:pt-32">
        {!hasMessages ? <div className="flex min-h-[52vh] flex-col items-center justify-center px-6 text-center"><IrisMark size={68} priority /><h1 className="mt-7 max-w-md text-[clamp(2rem,8vw,3.8rem)] font-medium leading-[1.02] tracking-[-.055em] text-slate-950">What would you like to think through?</h1></div> : null}
        <div className="mx-auto max-w-3xl space-y-7">
          {messages.map((message) => <MessageBubble key={message.id} message={message} />)}
          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 z-20 h-40 px-4 pb-[max(14px,env(safe-area-inset-bottom))] sm:h-44 sm:px-8">
        <ProceduralBlur edge="bottom" />
        <div className="relative mx-auto flex h-full max-w-3xl flex-col justify-end">
          {error ? <p className="mb-2 rounded-xl bg-red-50/90 px-3 py-2 text-xs font-medium text-red-600 backdrop-blur-xl">{error}</p> : null}
          <form onSubmit={sendMessage} className="glass-surface rounded-[28px] p-2 transition focus-within:bg-white/78 focus-within:shadow-[0_26px_70px_rgba(73,98,145,.18)]">
            <textarea value={composer} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} rows={1} placeholder="Message Iris" className="max-h-32 min-h-12 w-full resize-none bg-transparent px-3 py-3 text-[15px] leading-6 text-slate-900 outline-none placeholder:text-slate-400" disabled={sending} />
            <div className="flex justify-end px-1 pb-1"><button type="submit" disabled={!composer.trim() || sending} className="soft-press flex h-11 w-11 items-center justify-center rounded-[17px] bg-[#111827] text-lg font-light text-white shadow-[0_10px_22px_rgba(17,24,39,.18)] disabled:opacity-30" aria-label="Send message">{sending ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/35 border-t-white" /> : "↑"}</button></div>
          </form>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: Readonly<{ message: Message }>) {
  const isUser = message.role === "user";
  return (
    <div className={`message-arrive flex ${isUser ? "justify-end" : "justify-start"}`} id={`message-${message.id}`}>
      <div className={`max-w-[88%] sm:max-w-[76%] ${isUser ? "items-end" : "items-start"}`}>
        <div className={`text-[15px] leading-7 ${isUser ? "rounded-[24px] rounded-br-[8px] bg-[#111827] px-4 py-3 text-white shadow-[0_12px_28px_rgba(17,24,39,.12)]" : "px-1 py-1 text-slate-700"}`}>
          {message.content ? <p className="whitespace-pre-wrap">{message.content}</p> : <span className="inline-flex items-center gap-1.5 py-2 text-slate-400"><span className="thinking-dot h-1.5 w-1.5 rounded-full bg-[#6f8ee6]" /><span className="thinking-dot h-1.5 w-1.5 rounded-full bg-[#8da2e4]" /><span className="thinking-dot h-1.5 w-1.5 rounded-full bg-[#a0a9d9]" /></span>}
        </div>
        <p className={`mt-1.5 px-1 text-[10px] text-slate-400 ${isUser ? "text-right" : "text-left"}`}><span className="sr-only">{isUser ? "You" : "Iris"} · </span>{formatMessageTime(message.createdAt)}</p>
      </div>
    </div>
  );
}

function ChatSkeleton() {
  return <div className="mx-auto h-dvh max-w-4xl animate-pulse px-5 pt-8"><div className="h-10 w-44 rounded-2xl bg-white/55" /><div className="mt-[52vh] h-24 rounded-[28px] bg-white/55" /></div>;
}
