import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Recurring-pipeline wire contracts. A *pipeline schedule* attaches a reusable
// pipeline to a service (a `frame` block) and re-runs it on a recurring cadence —
// e.g. weekly dependency updates, or a tech-debt remediation pass. Each schedule
// owns exactly one reused on-board block (a `task` leaf inside the service frame);
// every time the schedule fires it starts the pipeline against that block, so the
// board shows a single recurring task whose live status and run history a human
// can inspect.
//
// The cadence is "run every `intervalHours`", optionally constrained to an
// allowed window — a set of weekdays plus an hour-of-day range (e.g. business
// hours) evaluated in the schedule's timezone. The engine rolls the computed next
// run forward until it lands inside an allowed window.
// ---------------------------------------------------------------------------

/** Template a schedule was created from; drives the seeded block description. */
export const scheduleTemplateSchema = v.picklist(['dep-update', 'tech-debt', 'custom'])
export type ScheduleTemplate = v.InferOutput<typeof scheduleTemplateSchema>

const hourOfDaySchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(23))
const weekdaySchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(6))

/**
 * How often a schedule fires and when it is allowed to. `intervalHours` is the
 * base cadence; `weekdays` (0=Sunday..6=Saturday; empty = every day) and the
 * `windowStartHour`/`windowEndHour` range (both null = any hour) gate which
 * instants are eligible, evaluated in `timezone` (an IANA zone, e.g.
 * "Europe/Helsinki"; default "UTC").
 */
export const recurrenceSchema = v.object({
  intervalHours: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(24 * 365)),
  /** Allowed weekdays (0–6). Empty means every day. */
  weekdays: v.array(weekdaySchema),
  /** Inclusive start of the allowed hour-of-day window, or null for no lower bound. */
  windowStartHour: v.nullable(hourOfDaySchema),
  /** Exclusive end of the allowed hour-of-day window, or null for no upper bound. */
  windowEndHour: v.nullable(hourOfDaySchema),
  /** IANA timezone the weekday/hour window is evaluated in. */
  timezone: v.string(),
})
export type Recurrence = v.InferOutput<typeof recurrenceSchema>

/**
 * A recurring pipeline attached to a service. `blockId` is the reused on-board
 * task block the pipeline runs against; `frameId` is the service frame it lives
 * in. `nextRunAt` is the computed epoch-ms of the next eligible fire (the global
 * sweeper queries `enabled AND nextRunAt <= now`).
 */
export const pipelineScheduleSchema = v.object({
  id: v.string(),
  /**
   * The account-owned service this schedule belongs to (in-org sharing): a schedule on a
   * shared service is visible on every workspace that mounts it and fires once per org.
   * Null for a legacy schedule not yet associated with a service.
   */
  serviceId: v.nullable(v.string()),
  blockId: v.string(),
  frameId: v.string(),
  pipelineId: v.string(),
  template: scheduleTemplateSchema,
  name: v.string(),
  recurrence: recurrenceSchema,
  enabled: v.boolean(),
  lastRunAt: v.nullable(v.number()),
  nextRunAt: v.number(),
  createdAt: v.number(),
})
export type PipelineSchedule = v.InferOutput<typeof pipelineScheduleSchema>

/** One historical fire of a schedule (retained ~1 week), surfaced in the inspector. */
export const scheduleRunSchema = v.object({
  id: v.string(),
  scheduleId: v.string(),
  /** The execution this fire started, or null if the start was skipped/failed. */
  executionId: v.nullable(v.string()),
  status: v.picklist(['running', 'done', 'failed', 'skipped']),
  startedAt: v.number(),
  finishedAt: v.nullable(v.number()),
  /** Short outcome line (e.g. a PR URL or "merged"), or null while running. */
  outcome: v.nullable(v.string()),
})
export type ScheduleRun = v.InferOutput<typeof scheduleRunSchema>

// ---- Request bodies -------------------------------------------------------

const scheduleNameSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80))

/** Create a recurring pipeline on a service frame. */
export const createScheduleSchema = v.object({
  frameId: v.string(),
  pipelineId: v.string(),
  template: v.optional(scheduleTemplateSchema, 'custom'),
  name: scheduleNameSchema,
  recurrence: recurrenceSchema,
  enabled: v.optional(v.boolean(), true),
  /**
   * The prompt/description for the reused on-board task block — the same free-text a
   * normal task carries, fed to every agent step. Omitted/empty ⇒ the template's seed
   * description. This is what lets a `custom` recurring task say what it should do.
   */
  description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(2000))),
})
export type CreateScheduleInput = v.InferOutput<typeof createScheduleSchema>

/** Patch an existing schedule (all fields optional). */
export const updateScheduleSchema = v.object({
  name: v.optional(scheduleNameSchema),
  pipelineId: v.optional(v.string()),
  recurrence: v.optional(recurrenceSchema),
  enabled: v.optional(v.boolean()),
})
export type UpdateScheduleInput = v.InferOutput<typeof updateScheduleSchema>
