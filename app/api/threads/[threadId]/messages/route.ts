import { NextResponse } from "next/server";
import { assertAppAccess } from "@/server/auth/gate";
import { getSelectedProfile } from "@/server/auth/profile";
import {
  createAgentRun,
  createMessage,
  applyAutomaticThreadTitle,
  claimAutomaticThreadTitle,
  findAgentRun,
  getProfile,
  getThread,
  getThreadContext,
  getThreadMessages,
  linkAgentRunMessages,
  appendAgentEvent,
  touchThread,
  updateAgentRunStatus,
} from "@/server/db/queries";
import {
  createAgentContext,
  resolveBrowserTimezone,
} from "@/server/agent/context";
import { buildThreadAgentContext, getModelMessages } from "@/server/agent/context-builder";
import { getConfiguredModelName, streamAgentEvents } from "@/server/agent";
import { resolveThreadTitle } from "@/server/agent/title";
import { createProductionMemoryRetrievalService } from "@/server/memory/retrieval";
import { createMemoryMutationService } from "@/server/memory/mutation";
import { createMemoryArchiveService } from "@/server/memory/archive";
import { createSupabaseMemoryStore } from "@/server/memory/repository";
import { createSupabaseMemoryGovernanceStore } from "@/server/memory/governance-repository";
import { budgetCanonicalMemory } from "@/server/memory/context-budget";
import { shouldEnqueueConsolidation } from "@/server/memory/consolidation";
import { readMemoryChangeHint } from "@/server/memory/reconciliation";
import { createSupabaseThreadCompactionStore } from "@/server/memory/compaction-repository";
import { getThreadCompactionConfig } from "@/server/memory/compaction";
import { planAssistantPersistence } from "@/server/agent/persistence";
import {
  AGENT_STREAM_PROTOCOL,
  safeFailure,
  type AgentStreamEvent,
} from "@/server/agent/protocol";

type MessagesRouteContext = { params: Promise<{ threadId: string }> };
type MessageRequest = {
  content?: unknown;
  requestId?: unknown;
  timezone?: unknown;
};

type OutgoingStreamEvent = {
  type: AgentStreamEvent["type"];
  runId: string;
  [key: string]: unknown;
};

function ndjson(event: AgentStreamEvent) {
  return `${JSON.stringify(event)}\n`;
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 200;
}

function isThreadId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function POST(request: Request, { params }: MessagesRouteContext) {
  try {
    await assertAppAccess();
  } catch {
    return NextResponse.json({ error: "App access is required." }, { status: 401 });
  }

  try {
    const profileId = await getSelectedProfile();
    const { threadId } = await params;
    if (!profileId) {
      return NextResponse.json({ error: "Select a profile first." }, { status: 400 });
    }
    if (!isThreadId(threadId)) {
      return NextResponse.json({ error: "Chat not found." }, { status: 404 });
    }

    const body = (await request.json()) as MessageRequest;
    if (typeof body.content !== "string" || body.content.trim().length === 0) {
      return NextResponse.json({ error: "Enter a message first." }, { status: 400 });
    }

    const content = body.content.trim().slice(0, 12000);
    const requestId = isRequestId(body.requestId) ? body.requestId.trim() : crypto.randomUUID();
    const thread = await getThread(profileId, threadId);
    if (!thread) {
      return NextResponse.json({ error: "Chat not found." }, { status: 404 });
    }

    const existingRun = await findAgentRun(profileId, threadId, requestId);
    if (existingRun) {
      return NextResponse.json(
        { run: existingRun, duplicate: true },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }

    const profile = await getProfile(profileId);
    if (!profile) {
      return NextResponse.json({ error: "Profile not found." }, { status: 404 });
    }

    const runId = crypto.randomUUID();
    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const model = getConfiguredModelName();
    let run;
    try {
      run = await createAgentRun({
        id: runId,
        profileId,
        threadId,
        requestId,
        model,
      });
    } catch {
      // A concurrent retry can win the unique request key between the lookup
      // above and insert. Return the existing scoped run instead of duplicating.
      const concurrentRun = await findAgentRun(profileId, threadId, requestId);
      if (concurrentRun) {
        return NextResponse.json(
          { run: concurrentRun, duplicate: true },
          { status: 409, headers: { "Cache-Control": "no-store" } },
        );
      }
      throw new Error("Could not create agent run.");
    }

    await createMessage({
      id: userMessageId,
      profileId,
      threadId,
      role: "user",
      content,
      agentRunId: run.id,
    });
    await linkAgentRunMessages(profileId, threadId, run.id, { userMessageId });

    const titleClaim = thread.thread.titleSource === "default"
      ? await claimAutomaticThreadTitle(profileId, threadId)
      : null;

    const memoryStore = createSupabaseMemoryStore();
    const memoryRetrieval = createProductionMemoryRetrievalService();
    const memoryRevisionSnapshotPromise = memoryStore.getCurrentRevision(profileId).catch(() => 0);
    const [history, threadContextRow, memoryRevisionSnapshot] = await Promise.all([
      getThreadMessages(profileId, threadId),
      getThreadContext(profileId, threadId),
      memoryRevisionSnapshotPromise,
    ]);
    const [canonicalMemory, memoryChangeHint] = await Promise.all([
      Promise.all([memoryStore.listDocuments(profileId), Promise.resolve(memoryRevisionSnapshot)])
        .then(([documents, globalRevision]) => budgetCanonicalMemory(documents, globalRevision, { profileId }))
        .catch(() => ({ globalRevision: 0, documents: [] })),
      readMemoryChangeHint({
        store: memoryStore,
        profileId,
        afterRevision: threadContextRow.memoryRevisionSeen,
        throughRevision: memoryRevisionSnapshot,
      }).catch(() => ({ afterRevision: threadContextRow.memoryRevisionSeen, throughRevision: memoryRevisionSnapshot, changes: [] })),
    ]);
    const agentContext = createAgentContext({
      profileId,
      profileLabel: profile.displayName,
      threadId,
      threadTitle: thread.thread.title,
      browserTimezone: resolveBrowserTimezone(body.timezone),
      continuitySummary: threadContextRow.continuitySummary,
      pinnedNotes: threadContextRow.pinnedNotes,
      compactedThroughMessageId: threadContextRow.compactedThroughMessageId,
      compactedThroughCreatedAt: threadContextRow.compactedThroughCreatedAt,
      continuityRevision: threadContextRow.continuityRevision,
      currentUserMessageId: userMessageId,
      agentRunId: run.id,
      canonicalMemory,
      memoryChangeHint,
    });
    const threadContext = buildThreadAgentContext({
      messages: history,
      continuitySummary: threadContextRow.continuitySummary,
      pinnedNotes: threadContextRow.pinnedNotes,
      compactedThroughMessageId: threadContextRow.compactedThroughMessageId,
      compactedThroughCreatedAt: threadContextRow.compactedThroughCreatedAt,
      continuityRevision: threadContextRow.continuityRevision,
      canonicalMemory,
    });
    const memoryMutation = createMemoryMutationService(memoryStore);
    const memoryArchive = createMemoryArchiveService(memoryStore);
    const memoryGovernance = createSupabaseMemoryGovernanceStore();
    const compactionStore = createSupabaseThreadCompactionStore();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        // Stream sequence numbers cover every client-visible event. Database
        // event sequences cover semantic persisted events only, so token
        // deltas never create gaps in either contract.
        let streamSequence = 0;
        let persistedSequence = 0;
        let assistantContent = "";
        let assistantPersisted = false;
        let closed = false;
        // Start the tiny title request before the agent iterator. It has its
        // own timeout/fallback and is never allowed to delay first-token work.
        const titlePromise = titleClaim
          ? resolveThreadTitle({ request: content })
          : null;

        const send = (event: OutgoingStreamEvent) => {
          if (closed) return;
          const next = {
            ...event,
            version: AGENT_STREAM_PROTOCOL,
            sequence: ++streamSequence,
          } as AgentStreamEvent;
          controller.enqueue(encoder.encode(ndjson(next)));
        };

        try {
          const titleTask = titlePromise
            ? titlePromise.then(async (title) => {
                try {
                  const updated = await applyAutomaticThreadTitle(profileId, threadId, title);
                  if (updated) send({ type: "title_updated", runId: run.id, title: updated.title });
                } catch {
                  // A title provider/database failure must never fail the run.
                }
              }).catch(() => undefined)
            : Promise.resolve();

          await appendAgentEvent({
            profileId,
            threadId,
            runId: run.id,
            sequence: ++persistedSequence,
            type: "run_started",
            payload: {
              requestId,
              userMessageId,
              assistantMessageId,
              model,
            },
          });
          send({
            type: "run_started",
            runId: run.id,
            requestId,
            userMessageId,
            assistantMessageId,
            at: new Date().toISOString(),
          });

          for await (const event of streamAgentEvents({
            context: agentContext,
            messages: getModelMessages(threadContext),
            memoryRetrieval,
            memoryMutation,
            memoryArchive,
          })) {
            if (event.type === "text_delta") {
              assistantContent += event.text;
              send({ type: "text_delta", runId: run.id, text: event.text });
              continue;
            }

            if (event.type === "tool_started") {
              await appendAgentEvent({
                profileId,
                threadId,
                runId: run.id,
                sequence: ++persistedSequence,
                type: "tool_call",
                payload: {
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  input: event.input,
                  ...(event.statusMessage ? { statusMessage: event.statusMessage } : {}),
                },
              });
              send({ ...event, runId: run.id });
              continue;
            }

            await appendAgentEvent({
              profileId,
              threadId,
              runId: run.id,
              sequence: ++persistedSequence,
              type: "tool_result",
              payload: {
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                output: event.output,
                ok: event.ok,
                ...(event.statusMessage ? { statusMessage: event.statusMessage } : {}),
              },
            });
            send({ ...event, runId: run.id });
          }

          await titleTask;

          if (assistantContent.trim().length === 0) {
            throw new Error("The assistant returned an empty response.");
          }

          const completedAssistant = planAssistantPersistence({
            content: assistantContent,
            failed: false,
          });
          if (!completedAssistant) {
            throw new Error("The assistant returned an empty response.");
          }

          await createMessage({
            id: assistantMessageId,
            profileId,
            threadId,
            role: "assistant",
            content: completedAssistant.content,
            agentRunId: run.id,
            isComplete: completedAssistant.isComplete,
          });
          assistantPersisted = true;
          await linkAgentRunMessages(profileId, threadId, run.id, { assistantMessageId });
          const completedAt = new Date().toISOString();
          await updateAgentRunStatus({
            profileId,
            threadId,
            runId: run.id,
            status: "completed",
            completedAt,
            failedAt: null,
            errorCode: null,
            errorMessage: null,
            errorMetadata: {},
          });
          await appendAgentEvent({
            profileId,
            threadId,
            runId: run.id,
            sequence: ++persistedSequence,
            type: "run_completed",
            payload: { assistantMessageId },
          });
          await touchThread(profileId, threadId);
          if (memoryStore.advanceThreadMemoryRevisionSeen) {
            try {
              await memoryStore.advanceThreadMemoryRevisionSeen(profileId, threadId, memoryRevisionSnapshot);
            } catch {
              // A reconciliation update must never turn a completed chat run into a failure.
            }
          }
          if (shouldEnqueueConsolidation({ runStatus: "completed", assistantPersisted })) {
            try {
              await memoryGovernance.enqueueConsolidationJob(profileId, threadId, run.id);
            } catch {
              // Memory queue availability must not turn a completed chat run into a failure.
            }
          }
          try {
            const compactionConfig = getThreadCompactionConfig();
            await compactionStore.enqueueCompactionJob(profileId, threadId, run.id, compactionConfig.minMessages, compactionConfig.recentTailMessages);
          } catch {
            // Compaction is a durable, opt-in follow-up and never blocks chat completion.
          }
          send({
            type: "completed",
            runId: run.id,
            assistantMessageId,
            at: completedAt,
          });
        } catch (error) {
          const failure = safeFailure(error);
          const partialAssistant = planAssistantPersistence({
            content: assistantContent,
            failed: true,
          });
          if (!assistantPersisted && partialAssistant) {
            try {
              await createMessage({
                id: assistantMessageId,
                profileId,
                threadId,
                role: "assistant",
                content: partialAssistant.content,
                agentRunId: run.id,
                isComplete: partialAssistant.isComplete,
              });
              assistantPersisted = true;
              await linkAgentRunMessages(profileId, threadId, run.id, { assistantMessageId });
            } catch {
              // Keep the run failure response safe even if persistence itself fails.
            }
          }

          const failedAt = new Date().toISOString();
          try {
            await updateAgentRunStatus({
              profileId,
              threadId,
              runId: run.id,
              status: "failed",
              completedAt: null,
              failedAt,
              errorCode: failure.code,
              errorMessage: failure.message,
              errorMetadata: { partial: assistantContent.length > 0 },
            });
            await appendAgentEvent({
              profileId,
              threadId,
              runId: run.id,
              sequence: ++persistedSequence,
              type: "run_failed",
              payload: { code: failure.code, partial: assistantContent.length > 0 },
            });
          } catch {
            // Do not expose database/provider details to the stream consumer.
          }
          send({
            type: "failed",
            runId: run.id,
            code: failure.code,
            message: failure.message,
            partial: assistantContent.length > 0,
            at: failedAt,
          });
        } finally {
          closed = true;
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  } catch {
    return NextResponse.json({ error: "Could not send that message." }, { status: 500 });
  }
}
