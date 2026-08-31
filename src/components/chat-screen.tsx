"use client";

import { FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
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
import {
  CHECKIN_QUICK_ACTIONS,
  pendingQuestionsByMessageId,
  type AttentionSnapshotPayload,
  type CheckinOutcome,
  type PendingQuestion,
} from "@/lib/checkin-actions";
import { resolveMessageHashTarget } from "@/lib/chat-source-navigation";
import { canSubmitMessage } from "@/lib/chat-composer";
import { appendVoiceTranscript, createVoiceWaveform, formatVoiceDuration, MAX_VOICE_RECORDING_SECONDS, preferredVoiceMimeType, voiceWaveformFromTimeDomain, VOICE_TRANSCRIPTION_POLL_INTERVAL_MS } from "@/lib/voice-input";
import { isConfirmedNewChatPromotion, isPersistedThreadId, messageEndpointForThread, UNSAVED_CHAT_ID } from "@/lib/chat-route";
import { createBottomScrollScheduler, INITIAL_SCROLL_FOLLOW_STATE, measureScrollFollowState, returnToBottomState, type ScrollFollowState } from "@/lib/chat-scroll";
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

type CheckinQuickActions = {
  questions: PendingQuestion[];
  busyKey: string | null;
  error: string | null;
  onAnswer: (question: PendingQuestion, outcome: CheckinOutcome) => Promise<void>;
};

type VoiceStopReason = "manual" | "limit";

type VoiceSession = {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: BlobPart[];
  startedAt: number;
  timer: number | null;
  audioContext: AudioContext | null;
  analyser: AnalyserNode | null;
  waveformFrame: number | null;
  waveformUpdatedAt: number;
  stopReason: VoiceStopReason;
  discarded: boolean;
};

type VoiceRun = {
  controller: AbortController;
  transcriptionId: string | null;
  cancelled: boolean;
};

function formatMessageTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function formatSourceDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function ChatScreen() {
  const params = useParams<{ threadId: string }>();
  const pathname = usePathname();
  // `/chat/new` has its own static route, so Next does not always expose a
  // `threadId` param there. Treat that route as the unsaved composer explicitly
  // instead of leaving the page in its persisted-thread loading state.
  const threadId = params.threadId ?? (pathname === "/chat/new" ? UNSAVED_CHAT_ID : "");
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
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const streamBufferRef = useRef<ReturnType<typeof createStreamEventBuffer> | null>(null);
  const scrollFollowRef = useRef<ScrollFollowState>(INITIAL_SCROLL_FOLLOW_STATE);
  const returningToBottomRef = useRef(false);
  const scrollSchedulerRef = useRef(createBottomScrollScheduler({
    reducedMotion: () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  }));
  const scrollStateFrameRef = useRef<number | null>(null);
  const [scrollFollow, setScrollFollow] = useState<ScrollFollowState>(INITIAL_SCROLL_FOLLOW_STATE);
  const entryAnimationRef = useRef(false);
  const [animateEmptyEntry, setAnimateEmptyEntry] = useState(false);
  const resolvedHashRef = useRef<string | null>(null);
  const persistedThreadIdRef = useRef<string | null>(null);
  const previousThreadIdRef = useRef(threadId);
  const activeRequestRef = useRef<AbortController | null>(null);
  const streamGenerationRef = useRef(0);
  const temporaryIdRef = useRef<string | null>(null);
  const [isTemporary, setIsTemporary] = useState(false);
  const [checkinQuestionsByMessage, setCheckinQuestionsByMessage] = useState<Map<string, PendingQuestion[]>>(() => new Map());
  const [answeringCheckinKey, setAnsweringCheckinKey] = useState<string | null>(null);
  const [checkinError, setCheckinError] = useState<string | null>(null);
  const [voiceState, setVoiceState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [voiceSeconds, setVoiceSeconds] = useState(0);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceStopReason, setVoiceStopReason] = useState<VoiceStopReason | null>(null);
  const [voiceWaveform, setVoiceWaveform] = useState<number[]>(() => createVoiceWaveform());
  const voiceSessionRef = useRef<VoiceSession | null>(null);
  const voiceRunRef = useRef<VoiceRun | null>(null);
  const voiceSourceRef = useRef<string | null>(null);

  function updateStreamState(next: StreamState | ((current: StreamState) => StreamState)) {
    setStreamState((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      return resolved;
    });
  }

  const messages = streamState.messages;
  const toolActivities = streamState.toolActivities;
  const hasMessages = messages.length > 0;
  const hasMessagesRef = useRef(hasMessages);
  const voiceBusy = voiceState !== "idle";

  useEffect(() => {
    hasMessagesRef.current = hasMessages;
  }, [hasMessages]);

  useEffect(() => () => {
    const session = voiceSessionRef.current;
    if (session) {
      session.discarded = true;
      disposeVoiceSession(session);
      if (session.recorder.state !== "inactive") session.recorder.stop();
    }
    const run = voiceRunRef.current;
    if (run) {
      run.cancelled = true;
      run.controller.abort();
      if (run.transcriptionId) void cancelRemoteTranscription(run.transcriptionId);
    }
  }, []);

  const loadCheckinQuestions = useCallback(async () => {
    try {
      const response = await fetch("/api/accountability/attention", { cache: "no-store" });
      const body = (await response.json()) as Partial<AttentionSnapshotPayload> & { error?: string };
      if (!response.ok || !body.pendingDeliveries || !body.counts) throw new Error(body.error ?? "Could not load check-ins.");
      setCheckinError(null);
      setCheckinQuestionsByMessage(pendingQuestionsByMessageId(body as AttentionSnapshotPayload));
    } catch {
      setCheckinQuestionsByMessage(new Map());
    }
  }, []);

  useEffect(() => {
    if (!profileId || loading || isNewChat) return;
    void loadCheckinQuestions();
  }, [isNewChat, loadCheckinQuestions, loading, profileId]);

  useEffect(() => {
    entryAnimationRef.current = false;
    setAnimateEmptyEntry(false);
    setIsTemporary(false);
    temporaryIdRef.current = null;
  }, [threadId]);

  // AppShell keeps one chat surface mounted during route transitions so the
  // first-message promotion can stay visually continuous. That also means a
  // route/profile change must explicitly invalidate the old request and its
  // presentation state; otherwise a late stream can write into the next chat.
  useEffect(() => {
    const previousThreadId = previousThreadIdRef.current;
    const promotedFromNewChat = isConfirmedNewChatPromotion(previousThreadId, threadId, persistedThreadIdRef.current)
      && hasMessagesRef.current;

    if (!promotedFromNewChat) {
      streamGenerationRef.current += 1;
      activeRequestRef.current?.abort();
      activeRequestRef.current = null;
      streamBufferRef.current?.cancel();
      streamBufferRef.current = null;
      persistedThreadIdRef.current = null;
      setSending(false);
      setPresentationActive(false);
      setComposer("");
    }
  }, [profileId, threadId]);

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
    const previousThreadId = previousThreadIdRef.current;
    previousThreadIdRef.current = threadId;
    if (isNewChat) {
      setThread(null);
      setDraftTitle("New chat");
      updateStreamState(createStreamState());
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const promotedFromNewChat = isConfirmedNewChatPromotion(previousThreadId, threadId, persistedThreadIdRef.current)
      && hasMessagesRef.current;
    // The first-message transaction has already committed before the route
    // handoff. Keep the live presentation and composer mounted while the
    // persisted thread metadata is reconciled in the background.
    if (!promotedFromNewChat) setLoading(true);
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
    const cancelReturnToBottom = () => {
      returningToBottomRef.current = false;
      scrollSchedulerRef.current.cancel();
    };
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
    if (!container) return;
    scrollSchedulerRef.current.request(
      () => scrollFollowRef.current.follow,
      (motion) => container.scrollTo({ top: container.scrollHeight, behavior: motion }),
    );
  }, [messages, toolActivities]);

  useEffect(() => () => scrollSchedulerRef.current.cancel(), [threadId]);

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
        target.addEventListener("animationend", () => target.classList.remove("message-source-highlight"), { once: true });
        window.setTimeout(() => target.classList.remove("message-source-highlight"), reducedMotion ? 0 : 1_600);
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
    streamGenerationRef.current += 1;
    activeRequestRef.current?.abort();
    activeRequestRef.current = null;
    streamBufferRef.current?.cancel();
    scrollSchedulerRef.current.cancel();
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
    if (voiceBusy || !canSubmitMessage(content, sending, presentationActive, hasChatTarget)) return;
    const voiceSource = voiceSourceRef.current;
    voiceSourceRef.current = null;
    if (voiceSource && voiceSource !== content) {
      void fetch("/api/transcribe/learn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ original: voiceSource, corrected: content }) }).catch(() => undefined);
    }
    setComposer("");
    setError(null);
    setSending(true);
    setPresentationActive(true);
    const optimisticUserId = `pending-user-${crypto.randomUUID()}`;
    const optimisticAssistantId = `pending-assistant-${crypto.randomUUID()}`;
    const requestId = crypto.randomUUID();
    const temporaryId = isTemporary ? (temporaryIdRef.current ?? (temporaryIdRef.current = crypto.randomUUID())) : null;
    const temporaryHistory = isTemporary
      ? messages
        .filter((message) => (message.role === "user" || message.role === "assistant") && message.content.trim() && message.isComplete !== false)
        .map((message) => ({ id: message.id, role: message.role, content: message.content }))
      : undefined;
    const now = new Date().toISOString();
    const optimisticThreadId = thread?.id ?? UNSAVED_CHAT_ID;
    const optimisticProfileId = thread?.profileId ?? profileId;
    const userMessage: Message = { id: optimisticUserId, presentationId: optimisticUserId, threadId: optimisticThreadId, profileId: optimisticProfileId, role: "user", content, createdAt: now };
    const assistantMessage: Message = { id: optimisticAssistantId, presentationId: optimisticAssistantId, threadId: optimisticThreadId, profileId: optimisticProfileId, role: "assistant", content: "", createdAt: now, isComplete: false };
    updateStreamState((current) => startOptimisticRun(current, { userMessage, assistantMessage }));
    const requestController = new AbortController();
    const requestGeneration = streamGenerationRef.current;
    activeRequestRef.current = requestController;
    const isCurrentRequest = () => activeRequestRef.current === requestController && streamGenerationRef.current === requestGeneration;
    const streamBuffer = createStreamEventBuffer((events) => {
      if (!isCurrentRequest()) return;
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
        signal: requestController.signal,
        body: JSON.stringify({ content, requestId, timezone, ...(isTemporary ? { temporary: true, temporaryId, history: temporaryHistory } : {}) }),
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
        if (!isCurrentRequest()) return;
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
      if (requestController.signal.aborted || !isCurrentRequest()) return;
      const message = sendError instanceof Error ? sendError.message : "Could not send that message.";
      streamBuffer.flush();
      setError(message);
      updateStreamState((current) => failStreamState(current, message));
    } finally {
      streamBuffer.flush();
      streamBuffer.cancel();
      if (streamBufferRef.current === streamBuffer) streamBufferRef.current = null;
      const ownsRequest = isCurrentRequest();
      if (ownsRequest) {
        activeRequestRef.current = null;
        setSending(false);
        if (isNewChat && persistedThreadIdRef.current) {
          router.replace(`/chat/${persistedThreadIdRef.current}`, { scroll: false });
        }
      }
    }
  }

  async function cancelRemoteTranscription(transcriptionId: string) {
    await fetch(`/api/transcribe/${transcriptionId}`, { method: "DELETE", cache: "no-store" }).catch(() => undefined);
  }

  async function waitForVoicePoll(signal: AbortSignal) {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Voice transcription was cancelled.", "AbortError"));
        return;
      }
      let timer = 0;
      const onAbort = () => {
        window.clearTimeout(timer);
        reject(new DOMException("Voice transcription was cancelled.", "AbortError"));
      };
      timer = window.setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, VOICE_TRANSCRIPTION_POLL_INTERVAL_MS);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function transcribeVoice(blob: Blob, context: string, stopReason: VoiceStopReason) {
    const run: VoiceRun = { controller: new AbortController(), transcriptionId: null, cancelled: false };
    voiceRunRef.current = run;
    setVoiceState("transcribing");
    setVoiceStopReason(stopReason);
    setVoiceError(null);
    try {
      const form = new FormData();
      form.append("audio", blob, `iris-voice.${blob.type.includes("mp4") ? "m4a" : "webm"}`);
      if (context.trim()) form.append("context", context.trim());
      const response = await fetch("/api/transcribe", { method: "POST", body: form, signal: run.controller.signal });
      const body = (await response.json().catch(() => null)) as { transcriptionId?: string; error?: string } | null;
      if (!response.ok || !body?.transcriptionId) throw new Error(body?.error ?? "Could not start voice transcription.");
      run.transcriptionId = body.transcriptionId;
      if (run.cancelled) {
        await cancelRemoteTranscription(run.transcriptionId);
        return;
      }
      const startedAt = Date.now();
      let firstPoll = true;
      while (Date.now() - startedAt < 4 * 60 * 1000) {
        if (!firstPoll) await waitForVoicePoll(run.controller.signal);
        firstPoll = false;
        const statusResponse = await fetch(`/api/transcribe/${body.transcriptionId}`, { cache: "no-store", signal: run.controller.signal });
        const statusBody = (await statusResponse.json().catch(() => null)) as { status?: string; text?: string | null; error?: string } | null;
        if (!statusResponse.ok) throw new Error(statusBody?.error ?? "Could not read the voice transcription.");
        if (statusBody?.status === "completed") {
          const transcript = statusBody.text?.trim();
          if (!transcript) throw new Error("The recording did not contain recognizable speech.");
          setComposer((current) => appendVoiceTranscript(current, transcript));
          voiceSourceRef.current = transcript;
          return;
        }
        if (statusBody?.status === "failed" || statusBody?.status === "cancelled") throw new Error(statusBody.error ?? "AssemblyAI could not transcribe that recording.");
      }
      throw new Error("Voice transcription took too long. Try a shorter recording.");
    } catch (transcriptionError) {
      if (!run.cancelled && !(transcriptionError instanceof DOMException && transcriptionError.name === "AbortError")) {
        setVoiceError(transcriptionError instanceof Error ? transcriptionError.message : "Could not transcribe that recording.");
      }
    } finally {
      if (voiceRunRef.current === run) {
        voiceRunRef.current = null;
        setVoiceState("idle");
        setVoiceStopReason(null);
        setVoiceWaveform(createVoiceWaveform());
      }
    }
  }

  function disposeVoiceSession(session: VoiceSession) {
    if (session.timer !== null) window.clearInterval(session.timer);
    session.timer = null;
    if (session.waveformFrame !== null) window.cancelAnimationFrame(session.waveformFrame);
    session.waveformFrame = null;
    session.audioContext?.close().catch(() => undefined);
    session.audioContext = null;
    session.stream.getTracks().forEach((track) => track.stop());
  }

  function stopVoiceRecording(reason: VoiceStopReason = "manual") {
    const session = voiceSessionRef.current;
    if (!session || session.recorder.state === "inactive") return;
    session.stopReason = reason;
    if (session.timer !== null) window.clearInterval(session.timer);
    session.timer = null;
    session.recorder.stop();
  }

  function cancelVoiceRecording() {
    const session = voiceSessionRef.current;
    if (!session) return;
    session.discarded = true;
    stopVoiceRecording();
    setVoiceState("idle");
    setVoiceSeconds(0);
    setVoiceStopReason(null);
    setVoiceWaveform(createVoiceWaveform());
    setVoiceError(null);
  }

  function cancelVoiceTranscription() {
    const run = voiceRunRef.current;
    if (!run) return;
    run.cancelled = true;
    run.controller.abort();
    if (run.transcriptionId) void cancelRemoteTranscription(run.transcriptionId);
    setVoiceState("idle");
    setVoiceStopReason(null);
    setVoiceWaveform(createVoiceWaveform());
    setVoiceError(null);
  }

  async function startVoiceRecording() {
    if (voiceBusy || sending || presentationActive) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setVoiceError("Voice input is not supported in this browser.");
      return;
    }
    setVoiceError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const mimeType = preferredVoiceMimeType((value) => MediaRecorder.isTypeSupported(value));
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 24_000 }) : new MediaRecorder(stream);
      const AudioContextConstructor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      let audioContext: AudioContext | null = null;
      let analyser: AnalyserNode | null = null;
      try {
        audioContext = AudioContextConstructor ? new AudioContextConstructor() : null;
        analyser = audioContext?.createAnalyser() ?? null;
        if (analyser && audioContext) {
          analyser.fftSize = 256;
          analyser.smoothingTimeConstant = 0.78;
          audioContext.createMediaStreamSource(stream).connect(analyser);
          void audioContext.resume().catch(() => undefined);
        }
      } catch {
        analyser = null;
        audioContext?.close().catch(() => undefined);
        audioContext = null;
      }
      const session: VoiceSession = { recorder, stream, chunks: [], startedAt: Date.now(), timer: null, audioContext, analyser, waveformFrame: null, waveformUpdatedAt: 0, stopReason: "manual", discarded: false };
      voiceSessionRef.current = session;
      recorder.ondataavailable = (event) => { if (event.data.size > 0) session.chunks.push(event.data); };
      recorder.onerror = () => setVoiceError("The browser could not record audio.");
      recorder.onstop = () => {
        const recorded = new Blob(session.chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
        const stopReason = session.stopReason;
        disposeVoiceSession(session);
        voiceSessionRef.current = null;
        if (session.discarded) return;
        if (recorded.size === 0) {
          setVoiceState("idle");
          setVoiceError("The recording was empty.");
          return;
        }
        void transcribeVoice(recorded, composer, stopReason);
      };
      const renderWaveform = (timestamp: number) => {
        if (voiceSessionRef.current !== session || session.recorder.state !== "recording" || !session.analyser) return;
        if (timestamp - session.waveformUpdatedAt >= 50) {
          const samples = new Uint8Array(session.analyser.fftSize);
          session.analyser.getByteTimeDomainData(samples);
          setVoiceWaveform(voiceWaveformFromTimeDomain(samples));
          session.waveformUpdatedAt = timestamp;
        }
        session.waveformFrame = window.requestAnimationFrame(renderWaveform);
      };
      recorder.start(250);
      setVoiceState("recording");
      setVoiceStopReason(null);
      setVoiceSeconds(0);
      session.waveformFrame = window.requestAnimationFrame(renderWaveform);
      session.timer = window.setInterval(() => {
        const elapsed = Math.min(MAX_VOICE_RECORDING_SECONDS, Math.floor((Date.now() - session.startedAt) / 1000));
        setVoiceSeconds(elapsed);
        if (elapsed >= MAX_VOICE_RECORDING_SECONDS) stopVoiceRecording("limit");
      }, 250);
    } catch (recordingError) {
      setVoiceState("idle");
      setVoiceError(recordingError instanceof DOMException && recordingError.name === "NotAllowedError" ? "Microphone permission was denied." : "Could not start the microphone.");
    }
  }

  function toggleVoiceRecording() {
    if (voiceState === "recording") stopVoiceRecording();
    else void startVoiceRecording();
  }

  useEffect(() => {
    if (!presentationActive || (streamState.status !== "completed" && streamState.status !== "failed")) return;
    const assistant = streamState.assistantMessageId
      ? streamState.messages.find((message) => message.id === streamState.assistantMessageId)
      : null;
    if (!assistant?.content) setPresentationActive(false);
  }, [presentationActive, streamState.assistantMessageId, streamState.messages, streamState.status]);

  async function answerCheckin(question: PendingQuestion, outcome: CheckinOutcome) {
    if (answeringCheckinKey) return;
    setAnsweringCheckinKey(question.key);
    setCheckinError(null);
    try {
      const response = await fetch("/api/accountability/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deliveryId: question.deliveryId, loopId: question.loopId, outcome }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string; warning?: string } | null;
      if (!response.ok) {
        throw new Error(body?.error ?? "Could not record your answer.");
      }
      if (body?.warning) setCheckinError(body.warning);
      await loadCheckinQuestions();
    } catch (answerError) {
      setCheckinError(answerError instanceof Error ? answerError.message : "Could not record your answer.");
    } finally {
      setAnsweringCheckinKey(null);
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

  function returnToBottom() {
    const container = scrollContainerRef.current;
    if (!container) return;
    scrollSchedulerRef.current.cancel();
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
  // A first-message promotion updates the URL before the persisted thread
  // metadata finishes loading. The optimistic messages are already the live
  // chat in that window, so do not replace it with a false not-found state.
  if (!thread && !isNewChat && !hasMessages) return <div className="mx-auto flex min-h-dvh max-w-xl items-center px-5"><div className="glass-surface w-full rounded-[28px] p-7 text-center"><p className="text-sm font-semibold text-red-500">Chat unavailable</p><p className="mt-2 text-sm text-slate-500">{error ?? "This chat could not be found in the selected profile."}</p><Link href="/history" className="mt-5 inline-flex text-sm font-semibold text-[#4978ed]">Back</Link></div></div>;

  return (
    <div className={`relative mx-auto flex h-dvh w-full max-w-5xl flex-col overflow-hidden ${animateEmptyEntry ? "chat-empty-entry" : ""}`}>
      <header className="absolute inset-x-0 top-0 z-40 h-28">
        <ProceduralBlur edge="top" />
        <div className="relative flex h-[72px] items-center gap-3 px-4 pt-[env(safe-area-inset-top)] sm:px-7">
          <Link href="/history" className="soft-press flex h-10 w-10 shrink-0 items-center justify-center rounded-[16px] bg-white/58 text-slate-700 shadow-[inset_0_0_0_1px_rgba(255,255,255,.8)] backdrop-blur-xl" aria-label="Back to history">
            <svg viewBox="0 0 24 24" className="h-[19px] w-[19px]" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" aria-hidden="true">
              <path d="M19 12H5" />
              <path d="m10 6-6 6 6 6" />
            </svg>
          </Link>
          <div className="min-w-0 flex-1">
            {editingTitle && thread ? <div className="flex items-center gap-2"><input autoFocus value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void saveTitle(); if (event.key === "Escape") setEditingTitle(false); }} className="min-w-0 flex-1 rounded-xl bg-white/65 px-3 py-2 text-sm font-semibold backdrop-blur-xl" /><button type="button" onClick={() => void saveTitle()} disabled={savingTitle} className="rounded-xl bg-[#111827] px-3 py-2 text-xs font-semibold text-white">{savingTitle ? "…" : "Save"}</button><button type="button" onClick={() => setEditingTitle(false)} className="px-2 py-2 text-xs font-semibold text-slate-500">Cancel</button></div> : thread ? <button type="button" onClick={() => setEditingTitle(true)} className="max-w-full truncate text-left text-sm font-semibold tracking-tight text-slate-800">{thread.title}</button> : <span className="flex max-w-full items-center gap-2 truncate text-sm font-semibold tracking-tight text-slate-800">New chat{isTemporary ? <span className="rounded-full bg-white/68 px-2 py-0.5 text-[10px] font-semibold tracking-normal text-slate-500">Temporary</span> : null}</span>}
          </div>
          <IrisMark size={34} />
        </div>
      </header>

      <div ref={scrollContainerRef} className="iris-scrollbar min-w-0 w-full flex-1 overflow-y-auto px-4 pb-40 pt-28 sm:px-8 sm:pb-44 sm:pt-32">
        {!hasMessages ? <div className="flex min-h-[52vh] flex-col items-center justify-center px-6 text-center"><IrisMark size={68} priority /><h1 className="mt-7 max-w-md text-[clamp(2rem,8vw,3.8rem)] font-medium leading-[1.02] tracking-[-.055em] text-slate-950">What would you like to think through?</h1></div> : null}
        <div className="mx-auto max-w-3xl space-y-7">
          {messages.map((message) => {
            const checkinQuestions = message.role === "assistant" ? checkinQuestionsByMessage.get(message.id) : undefined;
            return <MessageBubble key={message.presentationId ?? message.id} message={message} active={streamState.status === "running" && message.id === streamState.assistantMessageId} live={message.id === streamState.assistantMessageId && (presentationActive || streamState.status === "running")} terminal={message.id === streamState.assistantMessageId && (streamState.status === "completed" || streamState.status === "failed")} loopLedger={message.id === streamState.assistantMessageId ? streamState.loopLedger : undefined} toolActivities={toolActivitiesForRun(toolActivities, message.role === "assistant" ? message.agentRunId : null)} onRevealComplete={message.id === streamState.assistantMessageId ? () => setPresentationActive(false) : undefined} checkinActions={checkinQuestions ? { questions: checkinQuestions, busyKey: answeringCheckinKey, error: checkinError, onAnswer: answerCheckin } : undefined} />;
          })}
          <UnattachedToolActivities messages={messages} toolActivities={toolActivities} profileId={profileId} />
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 z-20 h-40 px-4 pb-[max(14px,env(safe-area-inset-bottom))] sm:h-44 sm:px-8">
        <ProceduralBlur edge="bottom" />
        <div className="relative mx-auto flex h-full max-w-3xl flex-col justify-end">
          {hasMessages && !scrollFollow.nearBottom ? <button type="button" onClick={returnToBottom} className="soft-press absolute left-1/2 top-1 z-10 flex h-10 w-10 -translate-x-1/2 items-center justify-center rounded-full border border-white/80 bg-white/72 text-lg text-slate-600 shadow-[0_12px_28px_rgba(81,104,151,.16)] backdrop-blur-xl" aria-label="Jump to latest message">↓</button> : null}
          {error ? <p className="mb-2 rounded-xl bg-red-50/90 px-3 py-2 text-xs font-medium text-red-600 backdrop-blur-xl">{error}</p> : null}
          <form onSubmit={sendMessage} className="chat-composer-focus-cue glass-surface rounded-[28px] p-2 transition focus-within:bg-white/78 focus-within:shadow-[0_26px_70px_rgba(73,98,145,.18)]">
            <textarea value={composer} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!sending && !presentationActive && !voiceBusy) event.currentTarget.form?.requestSubmit(); } }} rows={1} placeholder={voiceState === "recording" ? "Listening… release the mic when you’re done" : voiceState === "transcribing" ? "Transcribing your voice note…" : "Message Iris"} className={`max-h-32 min-h-12 w-full resize-none bg-transparent px-3 py-3 text-[15px] leading-6 text-slate-900 placeholder:text-slate-400 ${voiceState === "recording" ? "voice-listening-caret" : ""}`} />
            {voiceState !== "idle" ? <div className="voice-waveform-shell mx-2 mb-1 flex h-9 items-center gap-[3px] rounded-[14px] bg-[#f7f9ff]/75 px-3" aria-hidden="true">{voiceWaveform.map((height, index) => <span key={index} className={`voice-waveform-bar ${voiceState === "transcribing" ? "voice-waveform-bar-transcribing" : ""}`} style={{ height: `${height}%` }} />)}</div> : null}
            <div className="flex items-center justify-between gap-2 px-1 pb-1">
              <div className="flex min-w-0 items-center gap-1.5">
                {isNewChat && !hasMessages ? <button type="button" aria-pressed={isTemporary} onClick={() => setIsTemporary((current) => !current)} className={`rounded-xl px-2.5 py-2 text-[11px] font-semibold transition-colors ${isTemporary ? "bg-[#e7edff] text-[#416fd8]" : "text-slate-400 hover:bg-white/55 hover:text-slate-600"}`}>{isTemporary ? "Temporary · not saved" : "Temporary chat"}</button> : null}
                {voiceState === "recording" ? <span className="voice-status-breathe flex items-center gap-1.5 rounded-xl bg-[#e7edff]/80 px-2.5 py-2 text-[11px] font-semibold text-[#416fd8]" role="status"><span className="voice-pulse-dot h-1.5 w-1.5 rounded-full bg-[#4978ed]" />{formatVoiceDuration(voiceSeconds)} / {formatVoiceDuration(MAX_VOICE_RECORDING_SECONDS)}</span> : voiceState === "transcribing" ? <span className="flex items-center gap-1.5 rounded-xl bg-white/55 px-2.5 py-2 text-[11px] font-medium text-slate-500" role="status"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#4978ed]" />{voiceStopReason === "limit" ? "10:00 reached · transcribing" : "Transcribing"}</span> : null}
              </div>
              <div className="flex items-center gap-1.5">
                {voiceBusy ? <button type="button" onClick={voiceState === "recording" ? cancelVoiceRecording : cancelVoiceTranscription} className="soft-press rounded-xl px-2.5 py-2 text-[11px] font-semibold text-slate-500 transition hover:bg-white/70 hover:text-slate-800" aria-label={voiceState === "recording" ? "Cancel voice recording" : "Cancel voice transcription"}>Cancel</button> : null}
                <button type="button" onClick={toggleVoiceRecording} disabled={sending || presentationActive || voiceState === "transcribing"} className={`soft-press flex h-11 w-11 items-center justify-center rounded-[17px] shadow-[0_10px_22px_rgba(73,120,237,.12)] transition ${voiceState === "recording" ? "voice-mic-recording bg-[#4978ed] text-white" : "bg-white/65 text-slate-600 hover:bg-white/90"} disabled:opacity-30`} aria-label={voiceState === "recording" ? "Stop voice recording" : "Start voice recording"} aria-pressed={voiceState === "recording"}>
                  {voiceState === "recording" ? <span className="h-3.5 w-3.5 rounded-[4px] bg-white" /> : <svg viewBox="0 0 24 24" className="h-[19px] w-[19px]" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7" /></svg>}
                </button>
                <button type="submit" disabled={voiceBusy || !canSubmitMessage(composer, sending, presentationActive, Boolean(thread) || isNewChat)} className="soft-press flex h-11 w-11 items-center justify-center rounded-[17px] bg-[#111827] text-lg font-light text-white shadow-[0_10px_22px_rgba(17,24,39,.18)] disabled:opacity-30" aria-label="Send message">{sending ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/35 border-t-white" /> : "↑"}</button>
              </div>
            </div>
          </form>
          {voiceError ? <p className="mt-2 px-3 text-[11px] font-medium text-red-500" role="alert">{voiceError}</p> : <p className="mt-2 px-3 text-[10px] font-medium text-slate-400">Voice notes use English, Hindi, and your memory-aware vocabulary. Audio is not stored by Iris.</p>}
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message, active, live, terminal, toolActivities, onRevealComplete, checkinActions, loopLedger }: Readonly<{ message: Message; active: boolean; live: boolean; terminal: boolean; toolActivities: ToolActivity[]; onRevealComplete?: () => void; checkinActions?: CheckinQuickActions; loopLedger?: { created: string[]; closed: string[] } | null }>) {
  const ledgerVisible = Boolean(loopLedger && (loopLedger.created.length > 0 || loopLedger.closed.length > 0));
  const isUser = message.role === "user";
  const phase = assistantStreamPhase(message, active);
  const shouldAnimateEntry = Boolean(message.presentationId) && (isUser || Boolean(message.content));
  const memoryActivities = toolActivities.filter((activity) => activity.toolName === "memory_context");
  const regularActivities = toolActivities.filter((activity) => activity.toolName !== "memory_context");
  return (
    <div className={`${shouldAnimateEntry ? "message-arrive" : ""} flex ${isUser ? "justify-end" : "justify-start"}`} id={`message-${message.id}`}>
      <div className={`max-w-[88%] sm:max-w-[76%] ${isUser ? "items-end" : "items-start"}`}>
        {!isUser && memoryActivities.length > 0 ? <MemoryUsageDisclosure activities={memoryActivities} profileId={message.profileId} /> : null}
        {!isUser && regularActivities.length > 0 ? <ToolActivityDisclosure activities={regularActivities} active={active} profileId={message.profileId} /> : null}
        <div className={`text-[15px] leading-7 ${isUser ? "rounded-[24px] rounded-br-[8px] bg-[#111827] px-4 py-3 text-white shadow-[0_12px_28px_rgba(17,24,39,.12)]" : "px-1 py-1 text-slate-700"}`}>
          {message.content ? <AssistantMarkdown content={message.content} live={live} terminal={terminal} onRevealComplete={onRevealComplete} /> : phase === "thinking" && toolActivities.length === 0 ? <ThinkingIndicator /> : null}
        </div>
        {!isUser && checkinActions && checkinActions.questions.length > 0 ? (
          <div className="mt-2 space-y-2">
            {checkinActions.questions.map((question) => (
              <div key={question.key} className="rounded-[18px] bg-white/48 p-2.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,.72)]">
                <p className="truncate text-xs font-semibold text-slate-700">{question.title}</p>
                {question.informational ? (
                  <p className="mt-1 text-[11px] font-medium text-slate-500">No response needed</p>
                ) : (
                  <div className="mt-1.5 flex gap-2">
                    {CHECKIN_QUICK_ACTIONS.map(({ outcome, label }) => (
                      <button
                        key={outcome}
                        type="button"
                        disabled={checkinActions.busyKey !== null}
                        onClick={() => void checkinActions.onAnswer(question, outcome)}
                        className={`soft-press min-h-11 flex-1 rounded-[14px] px-2 text-xs font-semibold transition disabled:opacity-40 ${outcome === "done" ? "bg-[#111827] text-white shadow-[0_8px_18px_rgba(17,24,39,.16)]" : "bg-white/65 text-slate-600 shadow-[inset_0_0_0_1px_rgba(255,255,255,.78)]"}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {checkinActions.error ? <p className="px-1 text-[11px] font-medium text-red-500">{checkinActions.error}</p> : null}
          </div>
        ) : null}
        {!isUser && ledgerVisible && loopLedger ? (
          <p className="mt-1 px-1 text-[10px] font-medium text-emerald-700/80" aria-label="Tracking updates this turn">
            {[
              loopLedger.created.length > 0 ? `Tracked: ${loopLedger.created.join(", ")}` : null,
              loopLedger.closed.length > 0 ? `Closed: ${loopLedger.closed.join(", ")}` : null,
            ].filter(Boolean).join(" · ")}
          </p>
        ) : null}
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
  return <div className="message-arrive space-y-2 pl-1"><p className="text-[11px] font-medium text-slate-400">Saved run activity</p>{runs.map((runId) => {
    const runActivities = unattached.filter((activity) => activity.runId === runId);
    const memoryActivities = runActivities.filter((activity) => activity.toolName === "memory_context");
    const regularActivities = runActivities.filter((activity) => activity.toolName !== "memory_context");
    return <div key={runId}>{memoryActivities.length > 0 ? <MemoryUsageDisclosure activities={memoryActivities} profileId={profileId} /> : null}{regularActivities.length > 0 ? <ToolActivityDisclosure activities={regularActivities} active={false} profileId={profileId} /> : null}</div>;
  })}</div>;
}

function MemoryUsageDisclosure({ activities, profileId }: Readonly<{ activities: ToolActivity[]; profileId: ProfileId }>) {
  const [expanded, setExpanded] = useState(false);
  const activity = activities.at(-1) ?? activities[0];
  const detailsId = `memory-usage-${activity?.runId ?? "run"}`;
  const items = activity ? memoryItemRows("memory_context", activity.output) : [];
  const sources = activity ? memorySourceRows("memory_context", activity.output, profileId) : [];
  const referenceRevision = activity && activity.output && typeof activity.output === "object" && !Array.isArray(activity.output) && typeof activity.output.referenceRevision === "number" ? activity.output.referenceRevision : null;
  return <div className="tool-activity-disclosure mt-2 max-w-full">
    <button type="button" className="flex min-h-7 w-full items-center gap-2 text-left text-[11px] font-medium text-slate-500" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded((current) => !current)}>
      <ToolActivityIcon toolName="memory_context" />
      <span className="min-w-0 flex-1 truncate">Used memory</span>
      <svg viewBox="0 0 12 8" className={`h-2 w-3 shrink-0 text-slate-400 transition-transform duration-200 ease-out motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`} aria-hidden="true"><path d="m1 1 5 5 5-5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" /></svg>
    </button>
    <div id={detailsId} className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${expanded ? "grid-rows-[1fr] opacity-100" : "pointer-events-none grid-rows-[0fr] opacity-0"}`} aria-hidden={!expanded}>
      <div className="min-h-0 overflow-hidden"><div className="space-y-1 pb-1 pl-6 pt-1 text-[11px] text-slate-500">
        {items.map((item) => <Link key={`${item.canonicalKey}:${item.itemRevision}`} href={`/memory?item=${encodeURIComponent(item.canonicalKey)}`} className="group flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 transition hover:bg-white/60 hover:text-slate-800"><span className="min-w-0 flex-1 truncate">{item.excerpt}</span><span className="shrink-0 font-semibold text-[#4978ed] opacity-80 group-hover:opacity-100">Open memory</span></Link>)}
        {sources.map((row) => <SourceCard key={`${row.action.threadId}:${row.action.messageId}`} row={row} compact />)}
        {items.length === 0 && sources.length === 0 && referenceRevision !== null ? <p className="px-2 py-1.5">Reference history revision {referenceRevision}</p> : null}
      </div></div>
    </div>
  </div>;
}

function ToolActivityDisclosure({ activities, active, profileId }: Readonly<{ activities: ToolActivity[]; active: boolean; profileId: ProfileId }>) {
  const [expanded, setExpanded] = useState(active);
  const wasActive = useRef(active);
  const detailsId = `tool-activity-${activities[0]?.runId ?? "run"}`;
  const sourceRows = [...new Map(activities.flatMap((activity) => memorySourceRows(activity.toolName, activity.output, profileId))
    .map((row) => [`${row.action.threadId}:${row.action.messageId}`, row] as const)).values()];

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
    {sourceRows.length > 0 ? <div className="mt-2 space-y-2">{sourceRows.map((row) => <SourceCard key={`${row.action.threadId}:${row.action.messageId}`} row={row} />)}</div> : null}
  </div>;
}

function ToolActivityIcon({ toolName }: Readonly<{ toolName: string }>) {
  const icon = toolActivityIconName(toolName);
  if (icon === "clock") return <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M10 6v4l2.7 1.7" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" /></svg>;
  if (icon === "chat") return <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true"><path d="M4 4.5h12v8H9l-3.5 3v-3H4z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.4" /><path d="M7 8h6M7 10.5h4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.2" /></svg>;
  if (icon === "search") return <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true"><circle cx="8.5" cy="8.5" r="4.8" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="m12.2 12.2 4 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" /></svg>;
  if (icon === "memory") return <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true"><path d="M5.2 4.2h9.6v11.6H5.2z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.4" /><path d="M7.8 7.2h4.4M7.8 10h4.4M7.8 12.8h2.6" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.2" /></svg>;
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
      {memoryRows.length > 0 ? <div className="mt-2 space-y-1 pl-6">{memoryRows.map((row) => <div key={`${row.canonicalKey}:${row.itemRevision}`} className="rounded-lg bg-white/35 px-2 py-1.5 text-[11px] text-slate-500"><span className="font-semibold text-slate-700">{row.canonicalKey}</span><span className="ml-2 truncate">{row.excerpt}</span></div>)}</div> : null}
      {sourceRows.length === 0 && memoryRows.length === 0 && detail ? <details className="mt-1 pl-7 text-[11px] text-slate-400"><summary className="cursor-pointer select-none">View details</summary><pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-white/50 p-2 font-mono text-[10px] leading-4 text-slate-500">{detail}</pre></details> : null}
    </div>
  );
}

type SourcePreviewMessage = {
  messageId: string;
  threadId: string;
  profileId: ProfileId;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
};

type SourcePreviewPayload = {
  thread: { id: string; profileId: ProfileId; title: string; createdAt: string; updatedAt: string };
  target: SourcePreviewMessage;
  before: SourcePreviewMessage[];
  after: SourcePreviewMessage[];
};

function SourceCard({ row, compact = false }: Readonly<{ row: ReturnType<typeof memorySourceRows>[number]; compact?: boolean }>) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const href = buildOpenMessageHref(row.action);
  if (!href) return null;
  const roleLabel = row.role === "user" ? "You" : row.role === "assistant" ? "Iris" : row.role === "tool" ? "Tool" : "Source";
  return (
    <article className={`source-card rounded-[16px] border border-white/70 bg-white/48 shadow-[0_9px_24px_rgba(80,102,145,.08)] backdrop-blur-xl ${compact ? "p-2.5" : "p-3"}`}>
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[10px] bg-[#edf2ff] text-[#5577d8]" aria-hidden="true">
          <svg viewBox="0 0 20 20" className="h-3.5 w-3.5"><path d="M4 4.5h12v8H9l-3.5 3v-3H4z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.4" /></svg>
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-semibold text-slate-700">{row.threadTitle ?? "Historical chat"}</p>
          <p className="mt-0.5 text-[10px] text-slate-400">{roleLabel} · {formatSourceDate(row.createdAt)}</p>
        </div>
      </div>
      <p className={`mt-2 text-slate-600 ${compact ? "line-clamp-2 text-[10px] leading-4" : "line-clamp-3 text-[11px] leading-[1.55]"}`}>{row.excerpt}</p>
      <div className="mt-2.5 flex items-center gap-3">
        <button type="button" onClick={() => setPreviewOpen(true)} className="soft-press rounded-lg bg-white/65 px-2.5 py-1.5 text-[10px] font-semibold text-slate-600 transition hover:bg-white/90 hover:text-slate-800">Preview</button>
        <Link href={href} scroll={false} className="soft-press inline-flex items-center gap-1.5 rounded-lg px-1 py-1.5 text-[10px] font-semibold text-[#4978ed] transition hover:text-[#315fcf]">
          Open message
          <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden="true"><path d="M5 3.5h7.5V11M12.2 3.8 4 12" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.3" /></svg>
        </Link>
      </div>
      {previewOpen ? <SourcePreviewDialog row={row} href={href} onDismiss={() => setPreviewOpen(false)} /> : null}
    </article>
  );
}

function SourcePreviewDialog({ row, href, onDismiss }: Readonly<{ row: ReturnType<typeof memorySourceRows>[number]; href: string; onDismiss: () => void }>) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [closing, setClosing] = useState(false);
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; source?: SourcePreviewPayload; error?: string }>({ status: "loading" });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/threads/${row.action.threadId}/messages/${row.action.messageId}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as { source?: SourcePreviewPayload; error?: string };
        if (!response.ok || !body.source) throw new Error(body.error ?? "This source is no longer available.");
        setState({ status: "ready", source: body.source });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ status: "error", error: error instanceof Error ? error.message : "This source is no longer available." });
      });
    return () => controller.abort();
  }, [row.action.messageId, row.action.threadId]);

  function requestClose() {
    if (closing) return;
    setClosing(true);
    window.setTimeout(() => {
      dialogRef.current?.close();
      onDismiss();
    }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160);
  }

  const messages = state.source ? [...state.source.before, state.source.target, ...state.source.after] : [];
  return (
    <dialog ref={dialogRef} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); requestClose(); }} onClick={(event) => { if (event.target === dialogRef.current) requestClose(); }} className={`source-preview-dialog m-auto w-[min(92vw,38rem)] max-h-[min(78dvh,44rem)] overflow-hidden rounded-[26px] border border-white/80 bg-[#f7f9ff]/95 p-0 text-left text-slate-700 shadow-[0_30px_90px_rgba(50,70,112,.28)] backdrop-blur-2xl ${closing ? "source-preview-dialog--closing" : ""}`}>
      <div className="flex max-h-[min(78dvh,44rem)] flex-col">
        <header className="flex items-start gap-3 border-b border-white/75 px-5 py-4 sm:px-6">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-[.14em] text-[#6683ce]">Source preview</p>
            <h2 id={titleId} className="mt-1 truncate text-base font-semibold tracking-tight text-slate-900">{state.source?.thread.title ?? row.threadTitle ?? "Historical chat"}</h2>
            <p className="mt-1 text-[11px] text-slate-400">{formatSourceDate(state.source?.target.createdAt ?? row.createdAt)}</p>
          </div>
          <button type="button" onClick={requestClose} className="soft-press flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/65 text-slate-500" aria-label="Close source preview">
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" /></svg>
          </button>
        </header>
        <div className="iris-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
          {state.status === "loading" ? <div className="flex min-h-36 items-center justify-center gap-2 text-xs text-slate-400"><span className="h-2 w-2 animate-pulse rounded-full bg-[#7090e7]" />Loading context</div> : null}
          {state.status === "error" ? <div className="flex min-h-36 flex-col items-center justify-center text-center"><p className="text-sm font-semibold text-slate-700">Source unavailable</p><p className="mt-1 max-w-xs text-xs leading-5 text-slate-400">{state.error}</p></div> : null}
          {state.status === "ready" ? <div className="space-y-3">{messages.map((message) => {
            const target = message.messageId === state.source?.target.messageId;
            return <div key={message.messageId} className={`rounded-[18px] px-3.5 py-3 transition ${target ? "bg-[#e9efff] shadow-[inset_0_0_0_1px_rgba(87,120,210,.12)]" : "bg-white/48"}`}>
              <div className="flex items-center justify-between gap-3 text-[10px]"><span className={`font-semibold ${target ? "text-[#4d6fc9]" : "text-slate-500"}`}>{message.role === "user" ? "You" : message.role === "assistant" ? "Iris" : "Tool"}{target ? " · exact source" : ""}</span><time className="shrink-0 text-slate-400">{formatMessageTime(message.createdAt)}</time></div>
              <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-5 text-slate-600">{message.content}</p>
            </div>;
          })}</div> : null}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-white/75 px-5 py-3.5 sm:px-6">
          <button type="button" onClick={requestClose} className="rounded-xl px-3 py-2 text-[11px] font-semibold text-slate-500">Close</button>
          {state.status === "ready" ? <Link href={href} scroll={false} className="soft-press rounded-xl bg-[#111827] px-3.5 py-2 text-[11px] font-semibold text-white shadow-[0_8px_18px_rgba(17,24,39,.14)]">Open message</Link> : null}
        </footer>
      </div>
    </dialog>
  );
}
