"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ThinkingOrb } from "thinking-orbs";
import type { Message, PersistedToolEvent, Thread, ToolActivity } from "@/lib/types";
import type { ProfileId } from "@/lib/profiles";
import { IrisMark } from "@/components/iris-mark";
import { AssistantMarkdown } from "@/components/assistant-markdown";
import { ProceduralBlur } from "@/components/procedural-blur";
import { useProfile } from "@/components/profile-provider";
import { ProfilePicker } from "@/components/profile-picker";
import { useChatSurface } from "@/components/chat-surface-context";
import { DelayedPagePresence } from "@/components/delayed-page-presence";
import { buildOpenMessageHref, memoryItemRows, memorySourceRows } from "@/lib/memory-source";
import { resolveMessageHashTarget } from "@/lib/chat-source-navigation";
import { canSubmitMessage } from "@/lib/chat-composer";
import { isPersistedThreadId, messageEndpointForThread, UNSAVED_CHAT_ID } from "@/lib/chat-route";
import { INITIAL_SCROLL_FOLLOW_STATE, measureScrollFollowState, returnToBottomState, type ScrollFollowState } from "@/lib/chat-scroll";
import {
  AgentStreamParser,
  assistantStreamPhase,
  createStreamEventBuffer,
  createStreamState,
  failStreamState,
  groupToolEvents,
  reduceAgentStream,
  startOptimisticRun,
  summarizeToolActivity,
  summarizeToolResult,
  toolActivityIconName,
  toolActivitiesForRun,
  toolDetail,
  toolLabel,
  type StreamState,
} from "@/lib/agent-stream";

type ThreadResponse = { thread: Thread; messages: Message[]; toolActivities?: PersistedToolEvent[] };

function formatMessageTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export function ChatScreen() {
  const params = useParams<{ threadId: string }>();
  const threadId = params.threadId;
  const isNewChat = threadId === UNSAVED_CHAT_ID;
  const router = useRouter();
  const { profileId, isReady } = useProfile();
  const { setSurface } = useChatSurface();
  const [thread, setThread] = useState<Thread | null>(null);
  const [streamState, setStreamState] = useState<StreamState>(() => createStreamState());
  const [composer, setComposer] = useState("");
  const [loading, setLoading] = useState(!isNewChat);
  const [sending, setSending] = useState(false);
  const [presentationActive, setPresentationActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const streamBufferRef = useRef<ReturnType<typeof createStreamEventBuffer> | null>(null);
  const scrollFollowRef = useRef<ScrollFollowState>(INITIAL_SCROLL_FOLLOW_STATE);
  const returningToBottomRef = useRef(false);
  const scrollFrameRef = useRef<number | null>(null);
  const scrollStateFrameRef = useRef<number | null>(null);
  const [scrollFollow, setScrollFollow] = useState<ScrollFollowState>(INITIAL_SCROLL_FOLLOW_STATE);
  const entryAnimationRef = useRef(false);
  const [animateEmptyEntry, setAnimateEmptyEntry] = useState(false);
  const resolvedHashRef = useRef<string | null>(null);
  const persistedThreadIdRef = useRef<string | null>(null);

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
    entryAnimationRef.current = false;
    setAnimateEmptyEntry(false);
  }, [threadId]);

  useEffect(() => {
    setSurface({
      threadId,
      ready: !loading && (isNewChat || Boolean(thread)),
      isEmpty: !loading && messages.length === 0,
      isSending: sending,
    });
  }, [isNewChat, loading, messages.length, sending, setSurface, thread, threadId]);

  useEffect(() => () => setSurface(null), [setSurface, threadId]);

  useEffect(() => {
    if (loading || (!thread && !isNewChat) || messages.length !== 0 || entryAnimationRef.current) return;
    entryAnimationRef.current = true;
    setAnimateEmptyEntry(true);
  }, [isNewChat, loading, messages.length, thread]);

  useEffect(() => {
    if (!profileId || !threadId) return;
    if (isNewChat) {
      setThread(null);
      setDraftTitle("New chat");
      updateStreamState(createStreamState());
      setError(null);
      setLoading(false);
      return;
    }
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
  }, [isNewChat, profileId, threadId]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const publishScrollState = () => {
      scrollStateFrameRef.current = null;
      const next = scrollFollowRef.current;
      setScrollFollow((current) => current.nearBottom === next.nearBottom && current.manual === next.manual && current.follow === next.follow ? current : next);
    };
    const updateFollowState = () => {
      // Lock the imperative follow ref synchronously so a streamed DOM update
      // cannot auto-scroll before the batched button state catches up.
      const measured = measureScrollFollowState(container);
      if (measured.nearBottom) returningToBottomRef.current = false;
      scrollFollowRef.current = returningToBottomRef.current && !measured.nearBottom
        ? { nearBottom: false, manual: false, follow: true }
        : measured;
      if (scrollStateFrameRef.current === null) {
        scrollStateFrameRef.current = window.requestAnimationFrame(publishScrollState);
      }
    };
    updateFollowState();
    container.addEventListener("scroll", updateFollowState, { passive: true });
    const cancelReturnToBottom = () => { returningToBottomRef.current = false; };
    container.addEventListener("touchstart", cancelReturnToBottom, { passive: true });
    container.addEventListener("wheel", cancelReturnToBottom, { passive: true });
    return () => {
      container.removeEventListener("scroll", updateFollowState);
      container.removeEventListener("touchstart", cancelReturnToBottom);
      container.removeEventListener("wheel", cancelReturnToBottom);
      if (scrollStateFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollStateFrameRef.current);
        scrollStateFrameRef.current = null;
      }
    };
  }, [threadId]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !scrollFollowRef.current.follow) return;
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if (scrollFollowRef.current.follow) container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
    });
    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [messages, toolActivities]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const resolveHash = () => {
      const hash = window.location.hash;
      const targetId = resolveMessageHashTarget(hash, messages.map((message) => message.id));
      if (!targetId || resolvedHashRef.current === `${threadId}:${hash}`) return;
      const target = document.getElementById(`message-${targetId}`);
      if (!target) return;
      resolvedHashRef.current = `${threadId}:${hash}`;
      scrollFollowRef.current = { nearBottom: false, manual: true, follow: false };
      setScrollFollow(scrollFollowRef.current);
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const frame = window.requestAnimationFrame(() => {
        if (!target.isConnected) return;
        target.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
        target.classList.remove("message-source-highlight");
        void target.offsetWidth;
        target.classList.add("message-source-highlight");
      });
      return () => window.cancelAnimationFrame(frame);
    };
    const onHashChange = () => {
      resolvedHashRef.current = null;
      resolveHash();
    };
    window.addEventListener("hashchange", onHashChange);
    const cancel = resolveHash();
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      cancel?.();
    };
  }, [messages, threadId]);

  useEffect(() => () => {
    streamBufferRef.current?.cancel();
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
    if (scrollStateFrameRef.current !== null) window.cancelAnimationFrame(scrollStateFrameRef.current);
  }, []);

  useEffect(() => {
    if (streamState.status === "failed" && streamState.errorMessage) setError(streamState.errorMessage);
  }, [streamState.status, streamState.errorMessage]);

  useEffect(() => {
    const title = streamState.title;
    if (!title || !thread || title === thread.title) return;
    setThread((current) => current ? { ...current, title, titleSource: "automatic" } : current);
    setDraftTitle(title);
  }, [streamState.title, thread]);

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
    if (!profileId) return;
    const content = composer.trim();
    const hasChatTarget = Boolean(thread) || isNewChat;
    if (!canSubmitMessage(content, sending, presentationActive, hasChatTarget)) return;
    setComposer("");
    setError(null);
    setSending(true);
    setPresentationActive(true);
    const optimisticUserId = `pending-user-${crypto.randomUUID()}`;
    const optimisticAssistantId = `pending-assistant-${crypto.randomUUID()}`;
    const requestId = crypto.randomUUID();
    const now = new Date().toISOString();
    const optimisticThreadId = thread?.id ?? UNSAVED_CHAT_ID;
    const optimisticProfileId = thread?.profileId ?? profileId;
    const userMessage: Message = { id: optimisticUserId, presentationId: optimisticUserId, threadId: optimisticThreadId, profileId: optimisticProfileId, role: "user", content, createdAt: now };
    const assistantMessage: Message = { id: optimisticAssistantId, presentationId: optimisticAssistantId, threadId: optimisticThreadId, profileId: optimisticProfileId, role: "assistant", content: "", createdAt: now, isComplete: false };
    updateStreamState((current) => startOptimisticRun(current, { userMessage, assistantMessage }));
    const streamBuffer = createStreamEventBuffer((events) => {
      updateStreamState((current) => events.reduce(reduceAgentStream, current));
    });
    streamBufferRef.current = streamBuffer;
    const adoptPersistedRoute = (nextThreadId: string) => {
      persistedThreadIdRef.current = nextThreadId;
      // The transaction has committed before the response headers exist. Keep
      // reload/back addressable during a long stream without remounting the
      // active composer; the router handoff below completes after terminal.
      if (isNewChat && typeof window !== "undefined" && window.location.pathname === "/chat/new") {
        window.history.replaceState(window.history.state, "", `/chat/${nextThreadId}`);
      }
    };

    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const response = await fetch(messageEndpointForThread(threadId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, requestId, timezone }),
      });
      if (response.status === 409) {
        const duplicateBody = (await response.json().catch(() => null)) as { threadId?: string } | null;
        const duplicateThreadId = duplicateBody?.threadId ?? null;
        if (isNewChat && isPersistedThreadId(duplicateThreadId)) {
          router.replace(`/chat/${duplicateThreadId}`, { scroll: false });
          return;
        }
        await reloadThreadState();
        setPresentationActive(false);
        setError("That message was already submitted. Showing its saved run.");
        return;
      }
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Could not send that message.");
      }

      if (isNewChat) {
        const responseThreadId = response.headers.get("X-Iris-Thread-Id");
        if (isPersistedThreadId(responseThreadId)) adoptPersistedRoute(responseThreadId);
      }

      const reader = response.body.getReader();
      const parser = new AgentStreamParser();
      let terminalEventReceived = false;
      const consumeEvents = (events: Parameters<typeof reduceAgentStream>[1][]) => {
        if (isNewChat) {
          const started = events.find((streamEvent) => streamEvent.type === "run_started" && streamEvent.threadId);
          const startedThreadId = started?.type === "run_started" ? started.threadId ?? null : null;
          if (isPersistedThreadId(startedThreadId)) {
            adoptPersistedRoute(startedThreadId);
          }
        }
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
      if (isNewChat && persistedThreadIdRef.current) {
        router.replace(`/chat/${persistedThreadIdRef.current}`, { scroll: false });
      }
    }
  }

  useEffect(() => {
    if (!presentationActive || (streamState.status !== "completed" && streamState.status !== "failed")) return;
    const assistant = streamState.assistantMessageId
      ? streamState.messages.find((message) => message.id === streamState.assistantMessageId)
      : null;
    if (!assistant?.content) setPresentationActive(false);
  }, [presentationActive, streamState.assistantMessageId, streamState.messages, streamState.status]);

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

  function returnToBottom() {
    const container = scrollContainerRef.current;
    if (!container) return;
    const next = returnToBottomState();
    scrollFollowRef.current = next;
    setScrollFollow(next);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    returningToBottomRef.current = !reducedMotion;
    container.scrollTo({ top: container.scrollHeight, behavior: reducedMotion ? "auto" : "smooth" });
  }

  if (!isReady) return null;
  if (!profileId) return <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-5xl items-center px-5 py-12 sm:px-8"><ProfilePicker /></div>;
  if (loading) return <DelayedPagePresence active className="min-h-dvh" />;
  if (!thread && !isNewChat) return <div className="mx-auto flex min-h-dvh max-w-xl items-center px-5"><div className="glass-surface w-full rounded-[28px] p-7 text-center"><p className="text-sm font-semibold text-red-500">Chat unavailable</p><p className="mt-2 text-sm text-slate-500">{error ?? "This chat could not be found in the selected profile."}</p><Link href="/history" className="mt-5 inline-flex text-sm font-semibold text-[#4978ed]">Back</Link></div></div>;

  return (
    <div className={`relative mx-auto flex h-dvh w-full max-w-5xl flex-col overflow-hidden ${animateEmptyEntry ? "chat-empty-entry" : ""}`}>
      <header className="absolute inset-x-0 top-0 z-40 h-28">
        <ProceduralBlur edge="top" />
        <div className="relative flex h-[72px] items-center gap-3 px-4 pt-[env(safe-area-inset-top)] sm:px-7">
          <Link href="/history" className="soft-press flex h-10 w-10 shrink-0 items-center justify-center rounded-[16px] bg-white/58 text-xl font-light text-slate-700 shadow-[inset_0_0_0_1px_rgba(255,255,255,.8)] backdrop-blur-xl" aria-label="Back to history">←</Link>
          <div className="min-w-0 flex-1">
            {editingTitle && thread ? <div className="flex items-center gap-2"><input autoFocus value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void saveTitle(); if (event.key === "Escape") setEditingTitle(false); }} className="min-w-0 flex-1 rounded-xl bg-white/65 px-3 py-2 text-sm font-semibold backdrop-blur-xl" /><button type="button" onClick={() => void saveTitle()} disabled={savingTitle} className="rounded-xl bg-[#111827] px-3 py-2 text-xs font-semibold text-white">{savingTitle ? "…" : "Save"}</button><button type="button" onClick={() => setEditingTitle(false)} className="px-2 py-2 text-xs font-semibold text-slate-500">Cancel</button></div> : thread ? <button type="button" onClick={() => setEditingTitle(true)} className="max-w-full truncate text-left text-sm font-semibold tracking-tight text-slate-800">{thread.title}</button> : <span className="block max-w-full truncate text-sm font-semibold tracking-tight text-slate-800">New chat</span>}
          </div>
          <IrisMark size={34} />
        </div>
      </header>

      <div ref={scrollContainerRef} className="iris-scrollbar flex-1 overflow-y-auto px-4 pb-40 pt-28 sm:px-8 sm:pb-44 sm:pt-32">
        {!hasMessages ? <div className="flex min-h-[52vh] flex-col items-center justify-center px-6 text-center"><IrisMark size={68} priority /><h1 className="mt-7 max-w-md text-[clamp(2rem,8vw,3.8rem)] font-medium leading-[1.02] tracking-[-.055em] text-slate-950">What would you like to think through?</h1></div> : null}
        <div className="mx-auto max-w-3xl space-y-7">
          {messages.map((message) => <MessageBubble key={message.presentationId ?? message.id} message={message} active={streamState.status === "running" && message.id === streamState.assistantMessageId} live={message.id === streamState.assistantMessageId && (presentationActive || streamState.status === "running")} terminal={message.id === streamState.assistantMessageId && (streamState.status === "completed" || streamState.status === "failed")} toolActivities={toolActivitiesForRun(toolActivities, message.role === "assistant" ? message.agentRunId : null)} onRevealComplete={message.id === streamState.assistantMessageId ? () => setPresentationActive(false) : undefined} />)}
          <UnattachedToolActivities messages={messages} toolActivities={toolActivities} profileId={profileId} />
          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 z-20 h-40 px-4 pb-[max(14px,env(safe-area-inset-bottom))] sm:h-44 sm:px-8">
        <ProceduralBlur edge="bottom" />
        <div className="relative mx-auto flex h-full max-w-3xl flex-col justify-end">
          {hasMessages && !scrollFollow.nearBottom ? <button type="button" onClick={returnToBottom} className="soft-press absolute left-1/2 top-1 z-10 flex h-10 w-10 -translate-x-1/2 items-center justify-center rounded-full border border-white/80 bg-white/72 text-lg text-slate-600 shadow-[0_12px_28px_rgba(81,104,151,.16)] backdrop-blur-xl" aria-label="Jump to latest message">↓</button> : null}
          {error ? <p className="mb-2 rounded-xl bg-red-50/90 px-3 py-2 text-xs font-medium text-red-600 backdrop-blur-xl">{error}</p> : null}
          <form onSubmit={sendMessage} className="chat-composer-focus-cue glass-surface rounded-[28px] p-2 transition focus-within:bg-white/78 focus-within:shadow-[0_26px_70px_rgba(73,98,145,.18)]">
            <textarea value={composer} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!sending && !presentationActive) event.currentTarget.form?.requestSubmit(); } }} rows={1} placeholder="Message Iris" className="max-h-32 min-h-12 w-full resize-none bg-transparent px-3 py-3 text-[15px] leading-6 text-slate-900 placeholder:text-slate-400" />
            <div className="flex justify-end px-1 pb-1"><button type="submit" disabled={!canSubmitMessage(composer, sending, presentationActive, Boolean(thread) || isNewChat)} className="soft-press flex h-11 w-11 items-center justify-center rounded-[17px] bg-[#111827] text-lg font-light text-white shadow-[0_10px_22px_rgba(17,24,39,.18)] disabled:opacity-30" aria-label="Send message">{sending ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/35 border-t-white" /> : "↑"}</button></div>
          </form>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message, active, live, terminal, toolActivities, onRevealComplete }: Readonly<{ message: Message; active: boolean; live: boolean; terminal: boolean; toolActivities: ToolActivity[]; onRevealComplete?: () => void }>) {
  const isUser = message.role === "user";
  const phase = assistantStreamPhase(message, active);
  const shouldAnimateEntry = Boolean(message.presentationId) && (isUser || Boolean(message.content));
  return (
    <div className={`${shouldAnimateEntry ? "message-arrive" : ""} flex ${isUser ? "justify-end" : "justify-start"}`} id={`message-${message.id}`}>
      <div className={`max-w-[88%] sm:max-w-[76%] ${isUser ? "items-end" : "items-start"}`}>
        {!isUser && toolActivities.length > 0 ? <ToolActivityDisclosure activities={toolActivities} active={active} profileId={message.profileId} /> : null}
        <div className={`text-[15px] leading-7 ${isUser ? "rounded-[24px] rounded-br-[8px] bg-[#111827] px-4 py-3 text-white shadow-[0_12px_28px_rgba(17,24,39,.12)]" : "px-1 py-1 text-slate-700"}`}>
          {message.content ? <AssistantMarkdown content={message.content} live={live} terminal={terminal} onRevealComplete={onRevealComplete} /> : phase === "thinking" && toolActivities.length === 0 ? <ThinkingIndicator /> : null}
        </div>
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

function UnattachedToolActivities({ messages, toolActivities, profileId }: Readonly<{ messages: Message[]; toolActivities: ToolActivity[]; profileId: ProfileId }>) {
  const attachedRuns = new Set(messages.filter((message) => message.role === "assistant" && message.agentRunId).map((message) => message.agentRunId));
  const unattached = toolActivities.filter((activity) => !attachedRuns.has(activity.runId));
  if (unattached.length === 0) return null;
  const runs = [...new Set(unattached.map((activity) => activity.runId))];
  return <div className="message-arrive space-y-2 pl-1"><p className="text-[11px] font-medium text-slate-400">Saved run activity</p>{runs.map((runId) => <ToolActivityDisclosure key={runId} activities={unattached.filter((activity) => activity.runId === runId)} active={false} profileId={profileId} />)}</div>;
}

function ToolActivityDisclosure({ activities, active, profileId }: Readonly<{ activities: ToolActivity[]; active: boolean; profileId: ProfileId }>) {
  const [expanded, setExpanded] = useState(active);
  const wasActive = useRef(active);
  const detailsId = `tool-activity-${activities[0]?.runId ?? "run"}`;

  useEffect(() => {
    if (!active && wasActive.current) setExpanded(false);
    wasActive.current = active;
  }, [active]);

  return <div className="tool-activity-disclosure mt-2 max-w-full">
    <button type="button" className="flex min-h-7 w-full items-center gap-2 text-left text-[11px] font-medium text-slate-500" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded((current) => !current)}>
      <ToolActivityIcon toolName={activities.length === 1 ? activities[0].toolName : "multiple"} />
      <span className="min-w-0 flex-1 truncate">{summarizeToolActivity(activities)}</span>
      <svg viewBox="0 0 12 8" className={`h-2 w-3 shrink-0 text-slate-400 transition-transform duration-200 ease-out motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`} aria-hidden="true"><path d="m1 1 5 5 5-5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" /></svg>
    </button>
    <div id={detailsId} className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${expanded ? "grid-rows-[1fr] opacity-100" : "pointer-events-none grid-rows-[0fr] opacity-0"}`} aria-hidden={!expanded}>
      <div className="min-h-0 overflow-hidden"><div className="space-y-1 pb-1 pt-1" aria-label="Tool activity details">{activities.map((activity) => <ToolActivityRow key={`${activity.runId}:${activity.toolCallId}`} activity={activity} profileId={profileId} />)}</div></div>
    </div>
  </div>;
}

function ToolActivityIcon({ toolName }: Readonly<{ toolName: string }>) {
  const icon = toolActivityIconName(toolName);
  if (icon === "clock") return <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M10 6v4l2.7 1.7" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" /></svg>;
  if (icon === "chat") return <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true"><path d="M4 4.5h12v8H9l-3.5 3v-3H4z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.4" /><path d="M7 8h6M7 10.5h4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.2" /></svg>;
  return <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true"><path d="m7.5 5.5 2.5-2 2.5 2-1 1.6 1.6 1 1.9-.4 1 3-1.7 1-.1 2-1.8.8-1.4-1.3-1.8.7-1.7-1.4.6-1.9-1.3-1.3-1.8.2-1.2-2.8z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.2" /><circle cx="10" cy="9.8" r="2" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>;
}

function ToolActivityRow({ activity, profileId }: Readonly<{ activity: ToolActivity; profileId: ProfileId }>) {
  const detail = toolDetail(activity);
  const sourceRows = memorySourceRows(activity.toolName, activity.output, profileId);
  const memoryRows = memoryItemRows(activity.toolName, activity.output);
  const stateClass = activity.status === "running" ? "text-[#5577d8]" : activity.status === "failed" ? "text-red-500" : "text-slate-500";
  return (
    <div className="tool-activity-row px-1 text-xs text-slate-500" aria-label={`${toolLabel(activity.toolName)} ${activity.status}`} aria-live={activity.status === "running" ? "polite" : "off"}>
      <div className="flex items-center gap-2">
        <ToolActivityIcon toolName={activity.toolName} />
        <span className="min-w-0 flex-1 truncate font-medium text-slate-700">{toolLabel(activity.toolName)}</span>
      </div>
      <p className={`mt-1 pl-6 text-[11px] leading-4 ${stateClass}`}>{summarizeToolResult(activity)}</p>
      {sourceRows.length > 0 ? <div className="mt-2 space-y-1 pl-6">{sourceRows.map((row) => {
        const href = buildOpenMessageHref(row.action);
        return href ? <Link key={`${row.action.threadId}:${row.action.messageId}`} href={href} className="group flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-[11px] text-slate-500 transition hover:bg-white/60 hover:text-slate-800"><span className="min-w-0 flex-1 truncate">{row.excerpt}</span><span className="shrink-0 font-semibold text-[#4978ed] opacity-80 group-hover:opacity-100">Open source</span></Link> : null;
      })}</div> : null}
      {memoryRows.length > 0 ? <div className="mt-2 space-y-1 pl-6">{memoryRows.map((row) => <div key={`${row.canonicalKey}:${row.itemRevision}`} className="rounded-lg bg-white/35 px-2 py-1.5 text-[11px] text-slate-500"><span className="font-semibold text-slate-700">{row.canonicalKey}</span><span className="ml-2 truncate">{row.excerpt}</span></div>)}</div> : null}
      {sourceRows.length === 0 && memoryRows.length === 0 && detail ? <details className="mt-1 pl-7 text-[11px] text-slate-400"><summary className="cursor-pointer select-none">View details</summary><pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-white/50 p-2 font-mono text-[10px] leading-4 text-slate-500">{detail}</pre></details> : null}
    </div>
  );
}
