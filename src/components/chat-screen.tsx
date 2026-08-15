"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ThinkingOrb } from "thinking-orbs";
import type { Message, PersistedToolEvent, Thread, ToolActivity } from "@/lib/types";
import { IrisMark } from "@/components/iris-mark";
import { ProceduralBlur } from "@/components/procedural-blur";
import { useProfile } from "@/components/profile-provider";
import { ProfilePicker } from "@/components/profile-picker";
import {
  AgentStreamParser,
  assistantStreamPhase,
  createStreamEventBuffer,
  createStreamState,
  failStreamState,
  groupToolEvents,
  reduceAgentStream,
  startOptimisticRun,
  summarizeToolResult,
  toolActivitiesForRun,
  toolDetail,
  toolLabel,
  type StreamState,
} from "@/lib/agent-stream";

type ThreadResponse = { thread: Thread; messages: Message[]; toolActivities?: PersistedToolEvent[] };

function formatMessageTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function isNearScrollEnd(element: HTMLElement, threshold = 120) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

export function ChatScreen() {
  const params = useParams<{ threadId: string }>();
  const threadId = params.threadId;
  const { profileId, isReady } = useProfile();
  const [thread, setThread] = useState<Thread | null>(null);
  const [streamState, setStreamState] = useState<StreamState>(() => createStreamState());
  const [composer, setComposer] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const streamBufferRef = useRef<ReturnType<typeof createStreamEventBuffer> | null>(null);
  const shouldFollowRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);

  function updateStreamState(next: StreamState | ((current: StreamState) => StreamState)) {
    setStreamState((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      return resolved;
    });
  }

  const messages = streamState.messages;
  const toolActivities = streamState.toolActivities;
  const hasMessages = messages.length > 0;

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
          updateStreamState(createStreamState({
            messages: body.messages,
            toolActivities: groupToolEvents(body.toolActivities ?? []),
          }));
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
    const container = scrollContainerRef.current;
    if (!container) return;
    const updateFollowState = () => {
      shouldFollowRef.current = isNearScrollEnd(container);
    };
    updateFollowState();
    container.addEventListener("scroll", updateFollowState, { passive: true });
    return () => container.removeEventListener("scroll", updateFollowState);
  }, [threadId]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !shouldFollowRef.current) return;
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if (shouldFollowRef.current) container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
    });
    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [messages, toolActivities]);

  useEffect(() => () => {
    streamBufferRef.current?.cancel();
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  useEffect(() => {
    if (streamState.status === "failed" && streamState.errorMessage) setError(streamState.errorMessage);
  }, [streamState.status, streamState.errorMessage]);

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
    const requestId = crypto.randomUUID();
    const now = new Date().toISOString();
    const userMessage: Message = { id: optimisticUserId, threadId: thread.id, profileId: thread.profileId, role: "user", content, createdAt: now };
    const assistantMessage: Message = { id: optimisticAssistantId, threadId: thread.id, profileId: thread.profileId, role: "assistant", content: "", createdAt: now, isComplete: false };
    updateStreamState((current) => startOptimisticRun(current, { userMessage, assistantMessage }));
    const streamBuffer = createStreamEventBuffer((events) => {
      updateStreamState((current) => events.reduce(reduceAgentStream, current));
    });
    streamBufferRef.current = streamBuffer;

    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const response = await fetch(`/api/threads/${thread.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, requestId, timezone }),
      });
      if (response.status === 409) {
        await reloadThreadState();
        setError("That message was already submitted. Showing its saved run.");
        return;
      }
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Could not send that message.");
      }

      const reader = response.body.getReader();
      const parser = new AgentStreamParser();
      let terminalEventReceived = false;
      const consumeEvents = (events: Parameters<typeof reduceAgentStream>[1][]) => {
        if (events.some((streamEvent) => streamEvent.type === "completed" || streamEvent.type === "failed")) {
          terminalEventReceived = true;
        }
        streamBuffer.push(events);
        if (terminalEventReceived) streamBuffer.flush();
      };
      let done = false;
      while (!done) {
        const result = await reader.read();
        done = result.done;
        consumeEvents(parser.push(result.value ?? new Uint8Array()));
      }
      consumeEvents(parser.finish());
      streamBuffer.flush();
      if (!terminalEventReceived) {
        const streamError = "The assistant stream ended before completion.";
        setError(streamError);
        updateStreamState((current) => failStreamState(current, streamError));
      }
    } catch (sendError) {
      const message = sendError instanceof Error ? sendError.message : "Could not send that message.";
      streamBuffer.flush();
      setError(message);
      updateStreamState((current) => failStreamState(current, message));
    } finally {
      streamBuffer.flush();
      streamBuffer.cancel();
      if (streamBufferRef.current === streamBuffer) streamBufferRef.current = null;
      setSending(false);
    }
  }

  async function reloadThreadState() {
    if (!threadId) return;
    const response = await fetch(`/api/threads/${threadId}`, { cache: "no-store" });
    const body = (await response.json()) as Partial<ThreadResponse> & { error?: string };
    if (!response.ok || !body.thread || !body.messages) throw new Error(body.error ?? "Could not reload this chat.");
    setThread(body.thread);
    setDraftTitle(body.thread.title);
    updateStreamState(createStreamState({
      messages: body.messages,
      toolActivities: groupToolEvents(body.toolActivities ?? []),
    }));
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

      <div ref={scrollContainerRef} className="iris-scrollbar flex-1 overflow-y-auto px-4 pb-40 pt-28 sm:px-8 sm:pb-44 sm:pt-32">
        {!hasMessages ? <div className="flex min-h-[52vh] flex-col items-center justify-center px-6 text-center"><IrisMark size={68} priority /><h1 className="mt-7 max-w-md text-[clamp(2rem,8vw,3.8rem)] font-medium leading-[1.02] tracking-[-.055em] text-slate-950">What would you like to think through?</h1></div> : null}
        <div className="mx-auto max-w-3xl space-y-7">
          {messages.map((message) => <MessageBubble key={message.id} message={message} active={streamState.status === "running" && message.id === streamState.assistantMessageId} toolActivities={toolActivitiesForRun(toolActivities, message.role === "assistant" ? message.agentRunId : null)} />)}
          <UnattachedToolActivities messages={messages} toolActivities={toolActivities} />
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

function MessageBubble({ message, active, toolActivities }: Readonly<{ message: Message; active: boolean; toolActivities: ToolActivity[] }>) {
  const isUser = message.role === "user";
  const phase = assistantStreamPhase(message, active);
  return (
    <div className={`message-arrive flex ${isUser ? "justify-end" : "justify-start"}`} id={`message-${message.id}`}>
      <div className={`max-w-[88%] sm:max-w-[76%] ${isUser ? "items-end" : "items-start"}`}>
        <div className={`text-[15px] leading-7 ${isUser ? "rounded-[24px] rounded-br-[8px] bg-[#111827] px-4 py-3 text-white shadow-[0_12px_28px_rgba(17,24,39,.12)]" : "px-1 py-1 text-slate-700"}`}>
          {message.content ? <p className="whitespace-pre-wrap">{message.content}</p> : phase === "thinking" ? <ThinkingIndicator /> : null}
        </div>
        {!isUser && toolActivities.length > 0 ? <ToolActivityList activities={toolActivities} /> : null}
        {!isUser && phase === "incomplete" ? <p className="mt-1 px-1 text-[10px] font-medium text-amber-600">Incomplete response</p> : null}
        <p className={`mt-1.5 px-1 text-[10px] text-slate-400 ${isUser ? "text-right" : "text-left"}`}><span className="sr-only">{isUser ? "You" : "Iris"} · </span>{formatMessageTime(message.createdAt)}</p>
      </div>
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="assistant-thinking inline-flex items-center gap-2 py-1.5" role="status" aria-live="polite">
      <ThinkingOrb state="breathing" size={20} theme="auto" aria-label="Thinking" className="shrink-0" />
      <span className="text-xs font-medium text-slate-400">Thinking</span>
    </div>
  );
}

function UnattachedToolActivities({ messages, toolActivities }: Readonly<{ messages: Message[]; toolActivities: ToolActivity[] }>) {
  const attachedRuns = new Set(messages.filter((message) => message.role === "assistant" && message.agentRunId).map((message) => message.agentRunId));
  const unattached = toolActivities.filter((activity) => !attachedRuns.has(activity.runId));
  if (unattached.length === 0) return null;
  const runs = [...new Set(unattached.map((activity) => activity.runId))];
  return <div className="message-arrive space-y-2 pl-1"><p className="text-[11px] font-medium text-slate-400">Saved run activity</p>{runs.map((runId) => <ToolActivityList key={runId} activities={unattached.filter((activity) => activity.runId === runId)} />)}</div>;
}

function ToolActivityList({ activities }: Readonly<{ activities: ToolActivity[] }>) {
  return <div className="mt-2 space-y-1.5" aria-label="Tool activity">{activities.map((activity) => <ToolActivityRow key={`${activity.runId}:${activity.toolCallId}`} activity={activity} />)}</div>;
}

function ToolActivityRow({ activity }: Readonly<{ activity: ToolActivity }>) {
  const detail = toolDetail(activity);
  const stateLabel = activity.status === "running" ? "Running" : activity.status === "succeeded" ? "Succeeded" : "Failed";
  const stateClass = activity.status === "running" ? "text-[#5577d8]" : activity.status === "succeeded" ? "text-emerald-600" : "text-red-500";
  return (
    <div className="tool-activity-row rounded-[16px] border border-white/70 bg-white/42 px-3 py-2 text-xs text-slate-600 shadow-[0_8px_24px_rgba(81,104,151,.06)] backdrop-blur-xl" aria-label={`${toolLabel(activity.toolName)} ${stateLabel}`} aria-live={activity.status === "running" ? "polite" : "off"}>
      <div className="flex items-center gap-2">
        <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/70 text-[10px] ${stateClass}`} aria-hidden="true">{activity.status === "running" ? <span className="tool-pulse h-1.5 w-1.5 rounded-full bg-current" /> : activity.status === "succeeded" ? "✓" : "!"}</span>
        <span className="min-w-0 flex-1 truncate font-medium text-slate-700">{toolLabel(activity.toolName)}</span>
        <span className={`shrink-0 text-[10px] font-medium ${stateClass}`}>{stateLabel}</span>
      </div>
      <p className="mt-1 pl-7 text-[11px] leading-4 text-slate-500">{summarizeToolResult(activity)}</p>
      {detail ? <details className="mt-1 pl-7 text-[11px] text-slate-400"><summary className="cursor-pointer select-none">View details</summary><pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-white/50 p-2 font-mono text-[10px] leading-4 text-slate-500">{detail}</pre></details> : null}
    </div>
  );
}

function ChatSkeleton() {
  return <div className="mx-auto h-dvh max-w-4xl animate-pulse px-5 pt-8"><div className="h-10 w-44 rounded-2xl bg-white/55" /><div className="mt-[52vh] h-24 rounded-[28px] bg-white/55" /></div>;
}
