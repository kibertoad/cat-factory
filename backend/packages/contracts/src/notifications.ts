import * as v from 'valibot'
import { mergeAssessmentSchema } from './merge.js'

// ---------------------------------------------------------------------------
// Notification wire contracts. A notification is a first-class, human-actionable
// item surfaced on the board that is NOT a mid-pipeline gate (those are
// Decisions / approval gates parked inside a running pipeline). Notifications
// outlive the run that raised them and are resolved out-of-band:
//   - `merge_review`     — a `merger` agent scored a PR outside the task's
//                          auto-merge thresholds; a human decides whether to merge.
//   - `pipeline_complete`— a pipeline with no `merger` step finished; a human
//                          confirms the work as complete (and merges the PR).
//   - `ci_failed`        — the `ci-fixer` agent exhausted its attempt budget and
//                          CI is still red; a human takes over.
//
// In-app delivery is the only channel today, but the core models delivery behind
// a `NotificationChannel` port so email / Slack channels can be added later
// without touching the call sites that raise notifications.
// ---------------------------------------------------------------------------

/**
 * The kind of human-actionable event a notification represents. A closed set so
 * the frontend can switch on it to render the right action; extending it is a
 * one-line change here plus a handler in the worker's `act` route.
 */
export const notificationTypeSchema = v.picklist(['merge_review', 'pipeline_complete', 'ci_failed'])
export type NotificationType = v.InferOutput<typeof notificationTypeSchema>

/**
 * Lifecycle of a notification: `open` until a human engages, terminal `acted`
 * once its action ran (merged, confirmed, retried…), or `dismissed` when waved
 * off. Only `open` notifications surface on the board.
 */
export const notificationStatusSchema = v.picklist(['open', 'acted', 'dismissed'])
export type NotificationStatus = v.InferOutput<typeof notificationStatusSchema>

/**
 * Optional structured detail a notification carries for rendering its card —
 * e.g. a `merge_review` carries the agent's assessment + the PR it concerns. Kept
 * deliberately small and additive so new notification types can attach their own
 * context without a schema migration.
 */
export const notificationPayloadSchema = v.object({
  /** The `merger` agent's assessment, on a `merge_review`. */
  assessment: v.optional(mergeAssessmentSchema),
  /** Web URL of the PR the notification concerns, when one is known. */
  prUrl: v.optional(v.string()),
  /** The pipeline run that raised it, for display ("from the Full build run"). */
  pipelineName: v.optional(v.string()),
})
export type NotificationPayload = v.InferOutput<typeof notificationPayloadSchema>

/** A human-actionable item surfaced on the board. */
export const notificationSchema = v.object({
  id: v.string(),
  type: notificationTypeSchema,
  status: notificationStatusSchema,
  /** The block (task/frame) the notification is about; null for workspace-wide. */
  blockId: v.nullable(v.string()),
  /** The execution run that raised it, when applicable. */
  executionId: v.nullable(v.string()),
  /** Short headline shown on the card. */
  title: v.string(),
  /** Longer prose body / context. */
  body: v.string(),
  /** Optional structured detail for rendering (see {@link notificationPayloadSchema}). */
  payload: v.optional(v.nullable(notificationPayloadSchema)),
  createdAt: v.number(),
  /** When it left `open` (acted/dismissed); null while open. */
  resolvedAt: v.nullable(v.number()),
})
export type Notification = v.InferOutput<typeof notificationSchema>

// ---- Request bodies -------------------------------------------------------

/** How a human resolved a notification from its card. */
export const resolveNotificationActionSchema = v.picklist(['act', 'dismiss'])
export type ResolveNotificationAction = v.InferOutput<typeof resolveNotificationActionSchema>
