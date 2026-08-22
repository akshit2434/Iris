import { z } from "zod";

export const OPEN_LOOP_KINDS = ["commitment", "routine", "idea"] as const;
export const OPEN_LOOP_STATUSES = ["open", "paused", "done", "cancelled", "dropped"] as const;
export const CADENCE_KINDS = ["daily", "weekly", "interval_days"] as const;
export const RESPOND_OUTCOMES = ["done", "later", "drop"] as const;
export const LOOP_EVENT_KINDS = [
  "created",
  "clarified",
  "rescheduled",
  "paused",
  "resumed",
  "nudged",
  "completed",
  "cancelled",
  "dropped",
  "reopened",
  "suppressed",
  "note",
] as const;

export type OpenLoopKind = (typeof OPEN_LOOP_KINDS)[number];
export type OpenLoopStatus = (typeof OPEN_LOOP_STATUSES)[number];
export type CadenceKind = (typeof CADENCE_KINDS)[number];
export type LoopEventKind = (typeof LOOP_EVENT_KINDS)[number];
export type RespondOutcome = (typeof RESPOND_OUTCOMES)[number];

export const openLoopKindSchema = z.enum(OPEN_LOOP_KINDS);
export const openLoopStatusSchema = z.enum(OPEN_LOOP_STATUSES);
export const respondOutcomeSchema = z.enum(RESPOND_OUTCOMES);

export const respondInputSchema = z
  .object({
    deliveryId: z.string().min(1).max(200),
    loopId: z.string().min(1).max(200),
    outcome: respondOutcomeSchema,
  })
  .strict();

export const cadenceSchema = z
  .object({
    kind: z.enum(CADENCE_KINDS),
    timesPerPeriod: z.number().int().min(1).max(7).optional(),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
    intervalDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();

export type Cadence = z.infer<typeof cadenceSchema>;

export const createLoopInputSchema = z
  .object({
    title: z.string().min(1).max(300),
    details: z.string().min(1).max(5000).optional(),
    kind: openLoopKindSchema.default("commitment"),
    dueAt: z.string().datetime({ offset: true }).optional(),
    cadence: cadenceSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.kind === "routine") !== (value.cadence !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Routine loops require cadence; other kinds must not carry one",
      });
    }
  });

export type CreateLoopInput = z.infer<typeof createLoopInputSchema>;
