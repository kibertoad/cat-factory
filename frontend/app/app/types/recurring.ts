// Recurring-pipeline shapes, mirroring `@cat-factory/contracts` (recurring.ts). A
// schedule attaches a pipeline to a service frame and re-runs it on a cadence —
// run every `intervalHours`, constrained to an optional allowed window (weekdays +
// an hour-of-day range, in the schedule's timezone). Each schedule owns one reused
// on-board task block; firing it starts the pipeline against that block.
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  ScheduleTemplate,
  Recurrence,
  IssueIntakeConfig,
  PipelineSchedule,
  ScheduleRun,
  CreateScheduleInput,
  UpdateScheduleInput,
} from '@cat-factory/contracts'
