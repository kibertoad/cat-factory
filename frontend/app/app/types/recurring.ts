// Recurring-pipeline shapes, mirroring `@cat-factory/contracts` (recurring.ts). A
// schedule attaches a pipeline to a service frame and re-runs it on a cadence —
// run every `intervalHours`, constrained to an optional allowed window (weekdays +
// an hour-of-day range, in the schedule's timezone). Each schedule owns one reused
// on-board task block; firing it starts the pipeline against that block.

/** Template a schedule was created from; drives the seeded block description. */
export type ScheduleTemplate = 'dep-update' | 'tech-debt' | 'custom'

/** How often a schedule fires and when it is allowed to. */
export interface Recurrence {
  /** Base cadence in hours (≥1). */
  intervalHours: number
  /** Allowed weekdays (0=Sun..6=Sat). Empty = every day. */
  weekdays: number[]
  /** Inclusive start of the allowed hour-of-day window, or null for no lower bound. */
  windowStartHour: number | null
  /** Exclusive end of the allowed hour-of-day window, or null for no upper bound. */
  windowEndHour: number | null
  /** IANA timezone the weekday/hour window is evaluated in (e.g. 'UTC'). */
  timezone: string
}

/** A recurring pipeline attached to a service. */
export interface PipelineSchedule {
  id: string
  /** The reused on-board task block the pipeline runs against. */
  blockId: string
  /** The service frame it lives in. */
  frameId: string
  pipelineId: string
  template: ScheduleTemplate
  name: string
  recurrence: Recurrence
  enabled: boolean
  lastRunAt: number | null
  /** Computed epoch-ms of the next eligible fire. */
  nextRunAt: number
  createdAt: number
}

/** One historical fire of a schedule (retained ~1 week), shown in the inspector. */
export interface ScheduleRun {
  id: string
  scheduleId: string
  executionId: string | null
  status: 'running' | 'done' | 'failed' | 'skipped'
  startedAt: number
  finishedAt: number | null
  outcome: string | null
}

export interface CreateScheduleInput {
  frameId: string
  pipelineId: string
  template?: ScheduleTemplate
  name: string
  recurrence: Recurrence
  enabled?: boolean
  /** The prompt/description for the reused on-board task; empty → the template seed. */
  description?: string
}

export interface UpdateScheduleInput {
  name?: string
  pipelineId?: string
  recurrence?: Recurrence
  enabled?: boolean
}
