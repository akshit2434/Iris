import { describe, expect, it } from "vitest";
import type { ProfileId } from "@/lib/profiles";
import { createIrisAgent, createProductionChatModel, streamAgentEvents, type AgentRuntimeEvent } from "@/server/agent";
import { createAgentContext } from "@/server/agent/context";
import { createMemoryMutationService } from "@/server/memory/mutation";
import { createMemoryRetrievalService } from "@/server/memory/retrieval";
import type {
  AppliedMemoryDocumentRevision,
  CanonicalDocumentSearchResult,
  CanonicalMemoryDocument,
  MemoryStore,
  MessageContextWindow,
  MessageSearchInput,
  MessageSearchResult,
} from "@/server/memory/types";
import { memorySourceRows, validateOpenMessageAction } from "@/lib/memory-source";

const enabled = process.env.IRIS_RUN_LIVE_MEMORY_ACCEPTANCE === "1";
const PROFILE_ID: ProfileId = "profile-a";
const THREAD_A_ID = "00000000-0000-4000-8000-000000000011";
const MESSAGE_A_ID = "00000000-0000-4000-8000-000000000010";
const RUN_A_ID = "00000000-0000-4000-8000-000000000012";
const THREAD_B_ID = "00000000-0000-4000-8000-000000000014";
const MESSAGE_B_ID = "00000000-0000-4000-8000-000000000013";
const RUN_B_ID = "00000000-0000-4000-8000-000000000015";
const SOURCE_CREATED_AT = "2026-08-16T00:00:00.000Z";
const OPENROUTER_CHAT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

type FakeMessage = {
  id: string;
  threadId: string;
  profileId: ProfileId;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
};

type FakeState = {
  documents: Map<string, CanonicalMemoryDocument>;
  messages: Map<string, FakeMessage>;
  globalRevision: number;
  mutationApplied: boolean;
};

function createFakeStore(state: FakeState): MemoryStore {
  return {
    async listDocuments(profileId) {
      return [...state.documents.values()].filter((document) => document.profileId === profileId && !document.archivedAt);
    },
    async getDocument(profileId, logicalKey) {
      const document = state.documents.get(logicalKey);
      return document?.profileId === profileId && !document.archivedAt ? document : null;
    },
    async getCurrentRevision(profileId) {
      return profileId === PROFILE_ID ? state.globalRevision : 0;
    },
    async applyDocumentRevision(input): Promise<AppliedMemoryDocumentRevision> {
      const current = state.documents.get(input.logicalKey);
      if (input.expectedDocumentRevision !== null && input.expectedDocumentRevision !== undefined && current?.documentRevision !== input.expectedDocumentRevision) {
        throw new Error("stale memory revision");
      }
      if (input.mutationKind === "create" && current) throw new Error("memory document already exists");
      const documentRevision = (current?.documentRevision ?? 0) + 1;
      state.globalRevision += 1;
      const document: CanonicalMemoryDocument = {
        id: current?.id ?? "00000000-0000-4000-8000-000000000020",
        profileId: input.profileId,
        logicalKey: input.logicalKey,
        contentMarkdown: input.contentMarkdown,
        documentRevision,
        contentHash: `synthetic-${documentRevision}`,
        createdAt: current?.createdAt ?? SOURCE_CREATED_AT,
        updatedAt: SOURCE_CREATED_AT,
        archivedAt: null,
      };
      state.documents.set(input.logicalKey, document);
      state.mutationApplied = true;
      return {
        profileId: input.profileId,
        documentId: document.id,
        documentRevision,
        profileGlobalRevision: state.globalRevision,
        revisionId: "00000000-0000-4000-8000-000000000021",
        provenanceId: "00000000-0000-4000-8000-000000000022",
      };
    },
    async searchMessages(input: MessageSearchInput): Promise<MessageSearchResult[]> {
      if (input.profileId !== PROFILE_ID) return [];
      const source = state.messages.get(MESSAGE_A_ID);
      if (!source) return [];
      const queryTerms = input.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const sourceText = source.content.toLocaleLowerCase();
      const matches = queryTerms.some((term) => sourceText.includes(term) || term.includes("synthetic") || term.includes("cobalt"));
      return matches ? [{
        messageId: source.id,
        threadId: source.threadId,
        profileId: source.profileId,
        role: source.role,
        content: source.content,
        createdAt: source.createdAt,
        lexicalScore: 1,
        semanticScore: null,
        combinedScore: 1,
      }] : [];
    },
    async readMessageContext(profileId, messageId): Promise<MessageContextWindow | null> {
      const source = state.messages.get(messageId);
      if (!source || source.profileId !== profileId) return null;
      return {
        thread: {
          id: source.threadId,
          profileId: source.profileId,
          title: "Synthetic source",
          createdAt: source.createdAt,
          updatedAt: source.createdAt,
        },
        target: {
          messageId: source.id,
          threadId: source.threadId,
          profileId: source.profileId,
          role: source.role,
          content: source.content,
          createdAt: source.createdAt,
        },
        before: [],
        after: [],
      };
    },
    async searchDocuments(profileId, query, limit = 5): Promise<CanonicalDocumentSearchResult[]> {
      return [...state.documents.values()]
        .filter((document) => document.profileId === profileId && document.contentMarkdown.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
        .slice(0, limit)
        .map((document) => ({
          documentId: document.id,
          profileId: document.profileId,
          logicalKey: document.logicalKey,
          excerpt: document.contentMarkdown,
          documentRevision: document.documentRevision,
          updatedAt: document.updatedAt,
        }));
    },
  };
}

function toolNames(events: AgentRuntimeEvent[]) {
  return [...new Set(events.filter((event) => event.type === "tool_started" || event.type === "tool_finished").map((event) => event.toolName))].sort();
}

function hasFinishedTool(events: AgentRuntimeEvent[], toolName: string, predicate: (output: unknown) => boolean) {
  return events.some((event) => event.type === "tool_finished" && event.toolName === toolName && event.ok && predicate(event.output));
}

describe("guarded live memory acceptance", () => {
  it.runIf(enabled)("uses real agent tools with ephemeral synthetic state", async () => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("acceptance_key_missing");

    const state: FakeState = {
      documents: new Map(),
      messages: new Map([
        [MESSAGE_A_ID, {
          id: MESSAGE_A_ID,
          threadId: THREAD_A_ID,
          profileId: PROFILE_ID,
          role: "user",
          content: "Please remember this synthetic acceptance fact: the Iris demo color is cobalt blue.",
          createdAt: SOURCE_CREATED_AT,
        }],
        [MESSAGE_B_ID, {
          id: MESSAGE_B_ID,
          threadId: THREAD_B_ID,
          profileId: PROFILE_ID,
          role: "user",
          content: "Where did I originally state the synthetic acceptance fact?",
          createdAt: "2026-08-16T00:01:00.000Z",
        }],
      ]),
      globalRevision: 0,
      mutationApplied: false,
    };
    const store = createFakeStore(state);
    const memoryMutation = createMemoryMutationService(store);
    const memoryRetrieval = createMemoryRetrievalService({ store, semanticSearchEnabled: false });
    const originalFetch = globalThis.fetch;
    let providerCalls = 0;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === OPENROUTER_CHAT_ENDPOINT) providerCalls += 1;
      return originalFetch(input, init);
    };

    try {
      const chatAContext = createAgentContext({
        profileId: PROFILE_ID,
        profileLabel: "Synthetic profile",
        threadId: THREAD_A_ID,
        threadTitle: "Synthetic Chat A",
        browserTimezone: "UTC",
        currentUserMessageId: MESSAGE_A_ID,
        agentRunId: RUN_A_ID,
        now: new Date(SOURCE_CREATED_AT),
      });
      const chatAEvents: AgentRuntimeEvent[] = [];
      for await (const event of streamAgentEvents({
        model: createProductionChatModel(),
        context: chatAContext,
        memoryMutation,
        returnDirectTools: ["memory_patch"],
        forceToolName: "memory_patch",
        messages: [{
          role: "user",
          content: "This is synthetic and contains no personal data. I explicitly want you to remember one durable fact now: the Iris demo color is cobalt blue. Use the memory_patch tool immediately with logicalKey PROFILE.md, mutationKind create, expectedDocumentRevision null, and a full replacement Markdown document. Make the tool call your only action.",
        }],
      })) {
        chatAEvents.push(event);
      }

      const document = [...state.documents.values()][0];
      const chatBContext = createAgentContext({
        profileId: PROFILE_ID,
        profileLabel: "Synthetic profile",
        threadId: THREAD_B_ID,
        threadTitle: "Synthetic Chat B",
        browserTimezone: "UTC",
        currentUserMessageId: MESSAGE_B_ID,
        agentRunId: RUN_B_ID,
        canonicalMemory: {
          globalRevision: state.globalRevision,
          documents: document ? [{
            logicalKey: document.logicalKey,
            contentMarkdown: document.contentMarkdown,
            documentRevision: document.documentRevision,
            updatedAt: document.updatedAt,
          }] : [],
        },
        now: new Date("2026-08-16T00:02:00.000Z"),
      });
      const chatBEvents: AgentRuntimeEvent[] = [];
      for await (const event of streamAgentEvents({
        model: createProductionChatModel(),
        context: chatBContext,
        memoryRetrieval,
        returnDirectTools: ["search_messages", "read_messages"],
        forceToolName: "search_messages",
        messages: [{
          role: "user",
          content: "This is the second synthetic chat. The canonical memory snapshot contains the fact. I want to know where I originally stated it. Use search_messages now with the query synthetic acceptance fact, then provide the exact source action. Do not guess and do not use memory_search.",
        }],
      })) {
        chatBEvents.push(event);
      }

      const sourceRows = chatBEvents.flatMap((event) => event.type === "tool_finished" && event.toolName === "search_messages" ? memorySourceRows("search_messages", event.output, PROFILE_ID) : []);
      const action = sourceRows[0]?.action ?? null;
      const assertions = {
        providerRequestBudget: providerCalls === 2,
        chatAPatchStarted: chatAEvents.some((event) => event.type === "tool_started" && event.toolName === "memory_patch"),
        chatAPatchFinished: hasFinishedTool(chatAEvents, "memory_patch", (output) => Boolean(output && typeof output === "object" && !Array.isArray(output) && (output as Record<string, unknown>).status === "applied")),
        ephemeralMutationApplied: state.mutationApplied && state.documents.size === 1,
        chatBRetrievalStarted: chatBEvents.some((event) => event.type === "tool_started" && (event.toolName === "search_messages" || event.toolName === "read_messages")),
        chatBRetrievalFinished: chatBEvents.some((event) => event.type === "tool_finished" && event.ok && (event.toolName === "search_messages" || event.toolName === "read_messages")),
        validatedOpenMessageAction: Boolean(action && validateOpenMessageAction(action) && action.threadId === THREAD_A_ID && action.messageId === MESSAGE_A_ID),
      };
      const allPassed = Object.values(assertions).every(Boolean);
      console.log(`IRIS_LIVE_ACCEPTANCE_RESULT:${JSON.stringify({ model: (process.env.OPENROUTER_MODEL || "openai/gpt-5.6-luna").slice(0, 120), totalRequests: providerCalls + 2, observedToolNames: [...new Set([...toolNames(chatAEvents), ...toolNames(chatBEvents)])].sort(), assertions })}`);
      expect(allPassed).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
