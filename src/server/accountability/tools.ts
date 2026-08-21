import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";
import type { AgentContext } from "@/server/agent/context";
import {
  cadenceSchema,
  createLoopInputSchema,
  openLoopKindSchema,
  OPEN_LOOP_STATUSES,
} from "./types";
import { isTerminal, nextStatusOnEvent } from "./state-machine";
import {
  createProductionAccountabilityRepository,
  type AccountabilityRepository,
  type LoopEventActor,
  type OpenLoopRow,
} from "./repository";

const NEEDS_CONFIRMATION_MESSAGE =
  "Nothing was saved. Before creating this loop, clarify with the user why it matters, their capacity for it, realistic timing, and conflicts with existing commitments; only call again with confirm=true once those are settled.";

const RESUME_CHECK_HORIZON_NOTE = "Loop resumed; next check follows its stored due time.";

const loopListInputSchema = z.object({
  statuses: z.array(z.enum(OPEN_LOOP_STATUSES)).max(5).optional(),
});

const loopCreateInputSchema = z.object({
  title: z.string().trim().min(1).max(300),
  details: z.string().trim().min(1).max(5000).optional(),
  kind: openLoopKindSchema.default("commitment"),
  dueAt: z.string().datetime({ offset: true }).optional(),
  cadence: cadenceSchema.optional(),
  confirm: z.boolean(),
});

const loopUpdateInputSchema = z
  .object({
    loopId: z.string().uuid(),
    action: z.enum(["reschedule", "pause", "resume"]),
    dueAt: z.string().datetime({ offset: true }).optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.action === "reschedule") !== (value.dueAt !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Rescheduling requires dueAt; other actions must not carry one",
      });
    }
  });

const loopCloseInputSchema = z.object({
  loopId: z.string().uuid(),
  outcome: z.enum(["completed", "cancelled", "dropped"]).default("completed"),
});

const scheduleCheckInputSchema = z.object({
  loopId: z.string().uuid(),
  dueAt: z.string().datetime({ offset: true }),
});

export type LoopSummary = Pick<OpenLoopRow, "id" | "title" | "kind" | "status" | "dueAt"> & { updatedAt: string };

export type LoopListOutput =
  | { kind: "loop_list"; loops: LoopSummary[] }
  | { kind: "loop_list"; status: "error"; message: string };

export type LoopCreateOutput =
  | { kind: "loop_create"; status: "needs_confirmation"; message: string }
  | { kind: "loop_create"; status: "created"; loopId: string; dueAt: string | null }
  | { kind: "loop_create"; status: "error"; message: string };

export type LoopUpdateOutput =
  | { kind: "loop_update"; status: "updated"; loopId: string }
  | { kind: "loop_update"; status: "error"; message: string };

export type LoopCloseOutput =
  | { kind: "loop_close"; status: "closed"; loopId: string; cancelledChecks: number }
  | { kind: "loop_close"; status: "error"; message: string };

export type ScheduleCheckOutput =
  | { kind: "schedule_check"; status: "scheduled"; checkId: string; dueAt: string }
  | { kind: "schedule_check"; status: "error"; message: string };

function resolveRepository(repository?: AccountabilityRepository): AccountabilityRepository {
  return repository ?? createProductionAccountabilityRepository();
}

function errorOutput<K extends "loop_list" | "loop_create" | "loop_update" | "loop_close" | "schedule_check">(kind: K, error: unknown): Extract<
  K extends "loop_list" ? LoopListOutput
    : K extends "loop_create" ? LoopCreateOutput
    : K extends "loop_update" ? LoopUpdateOutput
    : K extends "loop_close" ? LoopCloseOutput
    : ScheduleCheckOutput,
  { status: "error" }
> {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "The request could not be completed.";
  return { kind, status: "error", message } as never;
}

function provenance(context: AgentContext): { actor: LoopEventActor; sourceThreadId: string; sourceMessageId: string | null; agentRunId: string | null } {
  return {
    actor: "agent",
    sourceThreadId: context.threadId,
    sourceMessageId: context.currentUserMessageId,
    agentRunId: context.agentRunId,
  };
}

function toSummary(row: OpenLoopRow): LoopSummary {
  return { id: row.id, title: row.title, kind: row.kind, status: row.status, dueAt: row.dueAt, updatedAt: row.updatedAt };
}

export async function listLoops(
  context: AgentContext,
  input: z.infer<typeof loopListInputSchema>,
  repository?: AccountabilityRepository,
): Promise<LoopListOutput> {
  try {
    const repo = resolveRepository(repository);
    const rows = input.statuses
      ? await repo.listOpenLoops(context.profileId, { statuses: input.statuses })
      : await repo.listOpenLoops(context.profileId);
    return { kind: "loop_list", loops: rows.map(toSummary) };
  } catch (error) {
    return errorOutput("loop_list", error);
  }
}

export async function createLoop(
  context: AgentContext,
  input: z.infer<typeof loopCreateInputSchema>,
  repository?: AccountabilityRepository,
): Promise<LoopCreateOutput> {
  if (!input.confirm) return { kind: "loop_create", status: "needs_confirmation", message: NEEDS_CONFIRMATION_MESSAGE };
  const parsed = createLoopInputSchema.safeParse({
    title: input.title.trim(),
    details: input.details === undefined ? undefined : input.details.trim(),
    kind: input.kind,
    dueAt: input.dueAt,
    cadence: input.cadence,
  });
  if (!parsed.success) {
    return errorOutput("loop_create", new Error(parsed.error.issues[0]?.message ?? "Invalid open loop input."));
  }
  try {
    const repo = resolveRepository(repository);
    const payload = parsed.data;
    const loop = await repo.insertOpenLoop({
      profileId: context.profileId,
      title: payload.title,
      ...(payload.details === undefined ? {} : { details: payload.details }),
      kind: payload.kind,
      ...(payload.dueAt === undefined ? {} : { dueAt: payload.dueAt }),
      ...(payload.cadence === undefined ? {} : { cadence: payload.cadence }),
    });
    await repo.insertLoopEvent(context.profileId, { loopId: loop.id, kind: "created", ...provenance(context) });
    if (loop.dueAt) await repo.insertScheduledCheck(context.profileId, { loopId: loop.id, dueAt: loop.dueAt });
    return { kind: "loop_create", status: "created", loopId: loop.id, dueAt: loop.dueAt };
  } catch (error) {
    return errorOutput("loop_create", error);
  }
}

const UPDATE_EVENT_BY_ACTION = {
  reschedule: "rescheduled",
  pause: "paused",
  resume: "resumed",
} as const;

export async function updateLoop(
  context: AgentContext,
  input: z.infer<typeof loopUpdateInputSchema>,
  repository?: AccountabilityRepository,
): Promise<LoopUpdateOutput> {
  try {
    const repo = resolveRepository(repository);
    const current = await repo.getOpenLoop(context.profileId, input.loopId);
    if (!current) return errorOutput("loop_update", new Error(`Open loop "${input.loopId}" was not found.`));
    const event = UPDATE_EVENT_BY_ACTION[input.action];
    const nextStatus = nextStatusOnEvent(current.status, event);
    if (nextStatus === null) {
      return errorOutput("loop_update", new Error(`Illegal open loop transition: "${event}" is not allowed from status "${current.status}".`));
    }
    const updated = await repo.updateOpenLoopStatus(
      context.profileId,
      current.id,
      current.updatedAt,
      input.action === "reschedule" && input.dueAt !== undefined ? { event, dueAt: input.dueAt } : { event },
    );
    const detail = input.action === "reschedule" ? `Rescheduled to ${input.dueAt}` : input.action === "resume" ? RESUME_CHECK_HORIZON_NOTE : null;
    await repo.insertLoopEvent(context.profileId, { loopId: current.id, kind: event, detail, ...provenance(context) });
    if (input.action === "pause") {
      await repo.cancelPendingChecksForLoop(context.profileId, current.id, "Loop paused");
    } else if (input.action === "reschedule") {
      await repo.cancelPendingChecksForLoop(context.profileId, current.id, "Rescheduled");
      if (nextStatus !== "paused") {
        await repo.insertScheduledCheck(context.profileId, { loopId: current.id, dueAt: input.dueAt! });
      }
    } else {
      await repo.cancelPendingChecksForLoop(context.profileId, current.id, "Resumed");
      if (current.dueAt && new Date(current.dueAt).getTime() > new Date(context.serverNow).getTime()) {
        await repo.insertScheduledCheck(context.profileId, { loopId: current.id, dueAt: current.dueAt });
      }
    }
    return { kind: "loop_update", status: "updated", loopId: updated.id };
  } catch (error) {
    return errorOutput("loop_update", error);
  }
}

export async function closeLoop(
  context: AgentContext,
  input: z.input<typeof loopCloseInputSchema>,
  repository?: AccountabilityRepository,
): Promise<LoopCloseOutput> {
  try {
    const repo = resolveRepository(repository);
    const outcome = input.outcome ?? "completed";
    const current = await repo.getOpenLoop(context.profileId, input.loopId);
    if (!current) return errorOutput("loop_close", new Error(`Open loop "${input.loopId}" was not found.`));
    if (nextStatusOnEvent(current.status, outcome) === null) {
      return errorOutput("loop_close", new Error(`Illegal open loop transition: "${outcome}" is not allowed from status "${current.status}".`));
    }
    const updated = await repo.updateOpenLoopStatus(context.profileId, current.id, current.updatedAt, { event: outcome });
    const cancelledChecks = await repo.cancelPendingChecksForLoop(context.profileId, current.id, `Loop ${outcome}`);
    await repo.insertLoopEvent(context.profileId, { loopId: current.id, kind: outcome, ...provenance(context) });
    return { kind: "loop_close", status: "closed", loopId: updated.id, cancelledChecks };
  } catch (error) {
    return errorOutput("loop_close", error);
  }
}

export async function scheduleCheck(
  context: AgentContext,
  input: z.infer<typeof scheduleCheckInputSchema>,
  repository?: AccountabilityRepository,
): Promise<ScheduleCheckOutput> {
  try {
    const repo = resolveRepository(repository);
    const current = await repo.getOpenLoop(context.profileId, input.loopId);
    if (!current) return errorOutput("schedule_check", new Error(`Open loop "${input.loopId}" was not found.`));
    if (isTerminal(current.status)) {
      return errorOutput("schedule_check", new Error(`Open loop "${input.loopId}" is ${current.status}; scheduled checks are rejected.`));
    }
    if (current.status === "paused") {
      return errorOutput("schedule_check", new Error(`Open loop "${input.loopId}" is paused; resume it before scheduling checks.`));
    }
    const check = await repo.insertScheduledCheck(context.profileId, { loopId: current.id, dueAt: input.dueAt });
    return { kind: "schedule_check", status: "scheduled", checkId: check.id, dueAt: check.dueAt };
  } catch (error) {
    return errorOutput("schedule_check", error);
  }
}

export function createAccountabilityTools(repository?: AccountabilityRepository) {
  let resolvedRepository = repository;
  const getRepository = () => {
    resolvedRepository ??= createProductionAccountabilityRepository();
    return resolvedRepository;
  };
  const loopListTool = tool(
    async (input: z.infer<typeof loopListInputSchema>, runtime: ToolRuntime<unknown, AgentContext>) => listLoops(runtime.context, input, getRepository()),
    {
      name: "loop_list",
      description:
        "List the current profile's open loops (commitments, routines, ideas) with statuses and due times. Use it before promising anything that overlaps existing responsibilities and whenever the user asks what is being tracked. Read-only; never invent loops or claim a write.",
      schema: loopListInputSchema,
    },
  );
  const loopCreateTool = tool(
    async (input: z.infer<typeof loopCreateInputSchema>, runtime: ToolRuntime<unknown, AgentContext>) => createLoop(runtime.context, input, getRepository()),
    {
      name: "loop_create",
      description:
        "Track a real responsibility as an open loop after the user commits to it. Always call with confirm=false first unless intent, capacity, realistic timing, and conflicts are already settled; an unconfirmed call persists nothing and returns clarification guidance. Commitments carry a dueAt and routines require cadence. Do not create loops for casual musings or things already finished.",
      schema: loopCreateInputSchema,
    },
  );
  const loopUpdateTool = tool(
    async (input: z.infer<typeof loopUpdateInputSchema>, runtime: ToolRuntime<unknown, AgentContext>) => updateLoop(runtime.context, input, getRepository()),
    {
      name: "loop_update",
      description:
        "Update an existing open loop by ID: reschedule it to a new dueAt, pause its check-ins, or resume a paused loop. Use it when timing changes or the user asks to stop or restart reminders. Rescheduling moves pending checks to the new time; do not use this to finish a loop, use loop_close instead.",
      schema: loopUpdateInputSchema,
    },
  );
  const loopCloseTool = tool(
    async (input: z.infer<typeof loopCloseInputSchema>, runtime: ToolRuntime<unknown, AgentContext>) => closeLoop(runtime.context, input, getRepository()),
    {
      name: "loop_close",
      description:
        "Close an open loop by ID with an explicit outcome: completed when the user states it is done anywhere in conversation, cancelled or dropped when they explicitly abandon it, cancelling all of its pending checks in the same step. The exact loop ID must come from loop_list or prefilled context; never guess IDs and never close loops the user did not clearly finish.",
      schema: loopCloseInputSchema,
    },
  );
  const scheduleCheckTool = tool(
    async (input: z.infer<typeof scheduleCheckInputSchema>, runtime: ToolRuntime<unknown, AgentContext>) => scheduleCheck(runtime.context, input, getRepository()),
    {
      name: "schedule_check",
      description:
        "Schedule one extra follow-up check for an open loop at an explicit time, such as 'ping me Friday about this'. Only open loops accept checks; closed or paused loops are rejected. Prefer rescheduling through loop_update over stacking redundant checks on the same loop.",
      schema: scheduleCheckInputSchema,
    },
  );
  return [loopListTool, loopCreateTool, loopUpdateTool, loopCloseTool, scheduleCheckTool];
}
