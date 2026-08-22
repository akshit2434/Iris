import "server-only";

import { PROFILE_IDS, type ProfileId } from "@/lib/profiles";
import { createMessage, listThreads } from "@/server/db/queries";
import {
  composeCheckinMessage,
  type CheckinComposer,
  type CheckinKind,
  type CheckinLoopRef,
} from "./composer";
import {
  createProductionAccountabilityRepository,
  normalizeSuppressionSubject,
  type AccountabilityRepository,
  type DeliverableDueCheck,
  type OpenLoopRow,
} from "./repository";
import {
  createProductionCommitmentRetrieval,
  createProductionCompletionClassifier,
  isReconciliationEligible,
  reconcileOverdueCommitments,
  type CompletionClassifier,
  type CommitmentSearchClient,
  type SoftClosePlan,
} from "./reconciler";

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
  cancelledOrphans: number;
  skippedNoThread: number;
  suppressed: number;
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

function warnSweepFailure(profileId: ProfileId, stage: string, error: unknown): void {
  const message = error instanceof Error
    ? error.message
    : (() => { try { return JSON.stringify(error); } catch { return String(error); } })();
  console.warn(JSON.stringify({ scope: "accountability-sweep", stage, profileId, error: message }));
}

export async function runAccountabilitySweep(input: {
  now?: string;
  profiles?: ProfileId[];
  limitPerProfile?: number;
  repository?: AccountabilityRepository;
  composer?: CheckinComposer;
  messageWriter?: SweepMessageWriter;
  threadLister?: SweepThreadLister;
  retrieval?: CommitmentSearchClient;
  classifier?: CompletionClassifier;
} = {}): Promise<SweepReport> {
  const now = input.now ?? new Date().toISOString();
  const profiles = input.profiles ?? [...PROFILE_IDS];
  const limitPerProfile = Math.max(1, input.limitPerProfile ?? DEFAULT_LIMIT_PER_PROFILE);
  const repository = input.repository ?? createProductionAccountabilityRepository();
  const composer = input.composer;
  const writeMessage = input.messageWriter ?? createDefaultMessageWriter();
  const listThreadsFor = input.threadLister ?? createDefaultThreadLister();

  let reconciliationSeams: { retrieval: CommitmentSearchClient; classifier: CompletionClassifier } | null | undefined;
  function resolveReconciliationSeams(profileId: ProfileId) {
    if (reconciliationSeams !== undefined) return reconciliationSeams;
    try {
      reconciliationSeams = {
        retrieval: input.retrieval ?? createProductionCommitmentRetrieval(),
        classifier: input.classifier ?? createProductionCompletionClassifier(),
      };
    } catch (error) {
      reconciliationSeams = null;
      warnSweepFailure(profileId, "reconciliation_seams", error);
    }
    return reconciliationSeams;
  }

  const reportProfiles: SweepProfileReport[] = [];

  for (const profileId of profiles) {
    try {
      const pairs = await repository.claimDueChecks(profileId, now, limitPerProfile);
      const suppressions = await repository.listActiveSuppressions(profileId);
      const suppressedSubjects = new Set(suppressions.map((suppression) => normalizeSuppressionSubject(suppression.subject)));
      const deliverable = pairs.filter((pair) => pair.loop.status === "open");
      const suppressedPairs = pairs.filter(
        (pair) => pair.loop.status === "open" && suppressedSubjects.has(normalizeSuppressionSubject(pair.loop.title)),
      );
      const activeDeliverable = deliverable.filter(
        (pair) => !suppressedSubjects.has(normalizeSuppressionSubject(pair.loop.title)),
      );
      if (suppressedPairs.length > 0) await repository.releaseClaims(profileId, suppressedPairs.map((pair) => pair.check.id));
      const staleLoopIds = [
        ...new Set(pairs.filter((pair) => pair.loop.status !== "open").map((pair) => pair.check.loopId)),
      ];
      let cancelledStale = 0;
      for (const loopId of staleLoopIds) {
        cancelledStale += await repository.cancelPendingChecksForLoop(profileId, loopId, STALE_PARENT_CANCEL_REASON);
      }
      const cancelledOrphans = await repository.cancelOrphanPendingDeliveries(profileId, now);

      const softClosePlans = new Map<string, SoftClosePlan>();
      const reconciliationTargets = activeDeliverable.filter((pair) => isReconciliationEligible(pair.loop, now));
      if (reconciliationTargets.length > 0) {
        const seams = resolveReconciliationSeams(profileId);
        if (seams) {
          try {
            const plans = await reconcileOverdueCommitments({
              profileId,
              loops: reconciliationTargets.map((pair) => pair.loop),
              now,
              retrieval: seams.retrieval,
              classifier: seams.classifier,
            });
            for (const [loopId, plan] of plans) softClosePlans.set(loopId, plan);
          } catch (error) {
            softClosePlans.clear();
            warnSweepFailure(profileId, "reconciliation", error);
          }
        }
      }
      const normalPairs = activeDeliverable.filter((pair) => !softClosePlans.has(pair.loop.id));

      let delivered = 0;
      let mergedBatches = 0;
      let skippedNoThread = 0;
      let failed = 0;

      if (activeDeliverable.length > 0) {
        const threads = await listThreadsFor(profileId);
        const threadId = threads[0]?.id ?? null;
        if (!threadId) {
          skippedNoThread = activeDeliverable.length;
          await repository.releaseClaims(profileId, activeDeliverable.map((pair) => pair.check.id));
        } else {
          const deliverBatch = async (batch: DeliverableDueCheck[], kind: CheckinKind, loops: CheckinLoopRef[]) => {
            try {
              const escalationTier = Math.max(...batch.map((pair) => pair.check.escalationTier));
              const composed = await composeCheckinMessage({ kind, loops, escalationTier, composer });
              const delivery = await repository.insertDelivery(profileId, { threadId });
              await repository.insertDeliveryItems(profileId, delivery.id, [...new Set(batch.map((pair) => pair.loop.id))]);
              const message = await writeMessage({ profileId, threadId, content: composed.text });
              await repository.markDeliveryDelivered(profileId, delivery.id, { messageId: message.id });
              for (const pair of batch) {
                const attemptCount = pair.check.attemptCount + 1;
                await repository.markCheckDelivered(profileId, pair.check.id, {
                  deliveryId: delivery.id,
                  deliveredAt: now,
                  attemptCount,
                  escalationTier: Math.min(attemptCount, MAX_ESCALATION_TIER),
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
            } catch (error) {
              failed += 1;
              warnSweepFailure(profileId, "delivery", error);
            }
          };

          for (const pair of activeDeliverable) {
            const plan = softClosePlans.get(pair.loop.id);
            if (!plan) continue;
            await deliverBatch([pair], "soft_close_confirm", [
              { title: pair.loop.title, evidenceExcerpt: plan.excerpt },
            ]);
          }
          for (const batch of chunkIntoBatches(normalPairs, SWEEP_MAX_BATCH)) {
            const kind = selectCheckinKind(batch.map((pair) => pair.loop), now);
            await deliverBatch(batch, kind, batch.map((pair) => ({ title: pair.loop.title })));
          }
        }
      }

      reportProfiles.push({
        profileId,
        selected: activeDeliverable.length,
        delivered,
        mergedBatches,
        cancelledStale,
        cancelledOrphans,
        skippedNoThread,
        suppressed: suppressedPairs.length,
        failed,
      });
    } catch (error) {
      reportProfiles.push({
        profileId,
        selected: 0,
        delivered: 0,
        mergedBatches: 0,
        cancelledStale: 0,
        cancelledOrphans: 0,
        skippedNoThread: 0,
        suppressed: 0,
        failed: 1,
      });
      warnSweepFailure(profileId, "profile", error);
    }
  }

  return { profiles: reportProfiles, at: now };
}
