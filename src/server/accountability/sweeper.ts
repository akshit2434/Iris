import "server-only";

import { PROFILE_IDS, type ProfileId } from "@/lib/profiles";
import { createMessage, listThreads } from "@/server/db/queries";
import { composeCheckinMessage, type CheckinComposer, type CheckinKind } from "./composer";
import {
  createProductionAccountabilityRepository,
  type AccountabilityRepository,
  type OpenLoopRow,
} from "./repository";

export const SWEEP_MAX_BATCH = 4;
export const DEFAULT_LIMIT_PER_PROFILE = 8;

const MS_PER_DAY = 86_400_000;
const CATCH_UP_THRESHOLD_DAYS = 2;
const MAX_ESCALATION_TIER = 5;
const STALE_PARENT_CANCEL_REASON = "Parent loop closed or paused before check-in";

export type SweepProfileReport = {
  profileId: ProfileId;
  selected: number;
  delivered: number;
  mergedBatches: number;
  cancelledStale: number;
  skippedNoThread: number;
  failed: number;
};

export type SweepReport = { profiles: SweepProfileReport[]; at: string };

export type SweepMessageWriter = (input: { profileId: ProfileId; threadId: string; content: string }) => Promise<{ id: string }>;

export type SweepThreadLister = (profileId: ProfileId) => Promise<Array<{ id: string }>>;

export function selectCheckinKind(loops: Array<Pick<OpenLoopRow, "kind" | "dueAt">>, nowIso: string): CheckinKind {
  const nowMs = Date.parse(nowIso);
  const overdueBeyondCatchUp = loops.some(
    (loop) => loop.dueAt !== null && nowMs - Date.parse(loop.dueAt) > CATCH_UP_THRESHOLD_DAYS * MS_PER_DAY,
  );
  if (overdueBeyondCatchUp) return "catch_up";
  if (loops.length > 1) return "merged_batch";
  if (loops[0]?.kind === "routine") return "routine_reflection";
  return "single_commitment";
}

function chunkIntoBatches<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function createDefaultMessageWriter(): SweepMessageWriter {
  return async ({ profileId, threadId, content }) => {
    const message = await createMessage({
      id: crypto.randomUUID(),
      profileId,
      threadId,
      role: "assistant",
      content,
      agentRunId: null,
      isComplete: true,
    });
    return { id: message.id };
  };
}

function createDefaultThreadLister(): SweepThreadLister {
  return async (profileId) => (await listThreads(profileId)).map((thread) => ({ id: thread.id }));
}

export async function runAccountabilitySweep(input: {
  now?: string;
  profiles?: ProfileId[];
  limitPerProfile?: number;
  repository?: AccountabilityRepository;
  composer?: CheckinComposer;
  messageWriter?: SweepMessageWriter;
  threadLister?: SweepThreadLister;
} = {}): Promise<SweepReport> {
  const now = input.now ?? new Date().toISOString();
  const profiles = input.profiles ?? [...PROFILE_IDS];
  const limitPerProfile = Math.max(1, input.limitPerProfile ?? DEFAULT_LIMIT_PER_PROFILE);
  const repository = input.repository ?? createProductionAccountabilityRepository();
  const composer = input.composer;
  const writeMessage = input.messageWriter ?? createDefaultMessageWriter();
  const listThreadsFor = input.threadLister ?? createDefaultThreadLister();

  const reportProfiles: SweepProfileReport[] = [];

  for (const profileId of profiles) {
    try {
      const pairs = await repository.listDeliverableDueChecks(profileId, now, limitPerProfile);
      const deliverable = pairs.filter((pair) => pair.loop.status === "open");
      const staleLoopIds = [
        ...new Set(pairs.filter((pair) => pair.loop.status !== "open").map((pair) => pair.check.loopId)),
      ];
      let cancelledStale = 0;
      for (const loopId of staleLoopIds) {
        cancelledStale += await repository.cancelPendingChecksForLoop(profileId, loopId, STALE_PARENT_CANCEL_REASON);
      }

      let delivered = 0;
      let mergedBatches = 0;
      let skippedNoThread = 0;
      let failed = 0;

      if (deliverable.length > 0) {
        const threads = await listThreadsFor(profileId);
        const threadId = threads[0]?.id ?? null;
        if (!threadId) {
          skippedNoThread = deliverable.length;
        } else {
          for (const batch of chunkIntoBatches(deliverable, SWEEP_MAX_BATCH)) {
            try {
              const kind = selectCheckinKind(batch.map((pair) => pair.loop), now);
              const composed = await composeCheckinMessage({
                kind,
                loops: batch.map((pair) => ({ title: pair.loop.title })),
                composer,
              });
              const delivery = await repository.insertDelivery(profileId, { threadId });
              const message = await writeMessage({ profileId, threadId, content: composed.text });
              await repository.markDeliveryDelivered(profileId, delivery.id, { messageId: message.id });
              for (const pair of batch) {
                const attemptCount = pair.check.attemptCount + 1;
                await repository.markCheckDelivered(profileId, pair.check.id, {
                  deliveryId: delivery.id,
                  deliveredAt: now,
                  attemptCount,
                  escalationTier: Math.min(attemptCount - 1, MAX_ESCALATION_TIER),
                });
                await repository.insertLoopEvent(profileId, {
                  loopId: pair.loop.id,
                  kind: "nudged",
                  actor: "system",
                  sourceThreadId: null,
                  sourceMessageId: null,
                  agentRunId: null,
                });
              }
              mergedBatches += 1;
              delivered += batch.length;
            } catch {
              failed += 1;
            }
          }
        }
      }

      reportProfiles.push({
        profileId,
        selected: deliverable.length,
        delivered,
        mergedBatches,
        cancelledStale,
        skippedNoThread,
        failed,
      });
    } catch {
      reportProfiles.push({
        profileId,
        selected: 0,
        delivered: 0,
        mergedBatches: 0,
        cancelledStale: 0,
        skippedNoThread: 0,
        failed: 1,
      });
    }
  }

  return { profiles: reportProfiles, at: now };
}
