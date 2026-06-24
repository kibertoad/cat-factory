import * as v from 'valibot'
import { createTaskTypeSchema } from './primitives.js'

// ---------------------------------------------------------------------------
// Per-workspace runtime settings. A single settings object per workspace (lazily
// seeded from the defaults) holding the operator-tunable policies that aren't
// per-task: how long a run may wait for a human before its notification escalates
// to red, and whether/how to cap the number of tasks running concurrently under one
// service. Persisted in the `workspace_settings` table on both runtime facades.
// ---------------------------------------------------------------------------

/**
 * How the per-service running-task limit is bucketed:
 *  - `off`      — no limit (the default).
 *  - `shared`   — one shared cap across all task types under a service.
 *  - `per_type` — a separate cap per task type under a service.
 */
export const taskLimitModeSchema = v.picklist(['off', 'shared', 'per_type'])
export type TaskLimitMode = v.InferOutput<typeof taskLimitModeSchema>

const limitSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000))

/** Per-task-type running-task caps (used when {@link taskLimitModeSchema} is `per_type`). */
export const taskLimitPerTypeSchema = v.record(createTaskTypeSchema, limitSchema)
export type TaskLimitPerType = v.InferOutput<typeof taskLimitPerTypeSchema>

/** A workspace's runtime settings. */
export const workspaceSettingsSchema = v.object({
  /**
   * Minutes a run may wait for human input before its open notification escalates
   * from `normal` (yellow) to `urgent` (red). The run itself is never auto-failed.
   */
  waitingEscalationMinutes: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100_000)),
  /** Whether/how the per-service running-task limit is enforced. */
  taskLimitMode: taskLimitModeSchema,
  /** The shared cap, when {@link taskLimitMode} is `shared`. Null otherwise. */
  taskLimitShared: v.nullable(limitSchema),
  /** The per-type caps, when {@link taskLimitMode} is `per_type`. Null otherwise. */
  taskLimitPerType: v.nullable(taskLimitPerTypeSchema),
})
export type WorkspaceSettings = v.InferOutput<typeof workspaceSettingsSchema>

/** Update a workspace's runtime settings (full replace of the supplied fields). */
export const updateWorkspaceSettingsSchema = v.object({
  waitingEscalationMinutes: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100_000)),
  ),
  taskLimitMode: v.optional(taskLimitModeSchema),
  taskLimitShared: v.optional(v.nullable(limitSchema)),
  taskLimitPerType: v.optional(v.nullable(taskLimitPerTypeSchema)),
})
export type UpdateWorkspaceSettingsInput = v.InferOutput<typeof updateWorkspaceSettingsSchema>
