import "server-only";

import type { ProfileId } from "@/lib/profiles";
import type { MemoryArchiveService } from "@/server/memory/archive";
import type { MemoryMutationService } from "@/server/memory/mutation";
import type { MemoryRetrieval } from "@/server/memory/retrieval";

/**
 * A deliberately boring implementation used when a profile or session has
 * disabled a memory layer.  Keeping the capability present but inert means
 * the model receives a truthful tool result instead of falling back to a
 * store it should not be able to reach.
 */
export function createDisabledMemoryRetrieval(reason = "Memory is disabled for this chat."): MemoryRetrieval {
  return {
    async searchMessages() { return []; },
    async readMessages() { return null; },
    async listMemory() { return []; },
    async currentRevision() { return 0; },
    async readMemory() { return null; },
    async searchMemory() { return []; },
  };
}

export function createDisabledMemoryMutation(reason = "Saved memory is disabled for this chat."): MemoryMutationService {
  return {
    async apply(input) {
      return {
        status: "conflict" as const,
        canonicalKey: input.canonicalKey.trim(),
        reason,
        candidates: [],
      };
    },
  };
}

export function createDisabledMemoryArchive(reason = "Saved memory is disabled for this chat."): MemoryArchiveService {
  return {
    async archive(input) {
      return {
        status: "conflict" as const,
        canonicalKey: input.canonicalKey.trim(),
        reason,
      };
    },
  };
}

export function createTemporaryThreadOverviewReader() {
  return async (profileId: ProfileId, threadId: string) => ({
    title: "Temporary chat",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageCount: 0,
  });
}
