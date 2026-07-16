import * as v from 'valibot'
import { mergeAssessmentSchema } from './merge.js'
import { onCallAssessmentSchema, releaseSignalSchema } from './release.js'

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
//   - `test_failed`      — the `fixer` agent exhausted its attempt budget (or there
//                          was no PR branch to fix) and the `tester` still withholds
//                          its greenlight; a human takes over.
//   - `requirement_review`— a requirements-review agent raised findings on a task
//                          (gaps / clarifications / risks); product people + the
//                          task's creator are told to go react to them. Purely
//                          informational (no typed side-effect — `act` just marks
//                          it read), unlike the engineering notifications above.
//   - `clarity_review`    — a clarity-review (bug-report triage) agent raised findings
//                          on a bug task; same informational shape as `requirement_review`.
//   - `release_regression`— the post-release-health gate detected a Datadog monitor/SLO
//                          regression after deploy and the `on-call` agent investigated;
//                          a human decides whether to revert the PR or acknowledge. Carries
//                          the on-call assessment + the regressed signals in its payload.
//   - `human_review`     — the `human-review` gate is waiting on a human code reviewer on
//                          the PR (no reviewer assigned, or assigned but not yet approved).
//                          Informational + a deep-link to the parked task (where the human
//                          can also request a freeform fix); the gate waits indefinitely and
//                          the severity sweep escalates the card the longer it waits.
//   - `fork_decision_pending`— the optional implementation-fork phase on a Coder step
//                          surfaced materially different ways to implement the task and the
//                          run parked for a human to choose. Informational + a deep-link to the
//                          parked task (where the fork-decision window lets the human pick /
//                          type a custom approach / chat); `act` just marks it read.
//   - `pr_review_ready`  — the `pr-reviewer` deep-reviewed an open PR and the run parked for a
//                          human to SELECT which of the sliced, prioritized findings to act on.
//                          Informational + a deep-link to the parked task (where the PR-review
//                          window lists the findings grouped by slice); `act` just marks it read.
//   - `initiative`       — the initiative execution loop needs a human: a spawned task was
//                          blocked (its phase is halted until it is retried/skipped), or the
//                          initiative finished (every planned task resolved). Informational +
//                          a deep-link to the initiative block; `act` just marks it read.
//   - `decision_required`— an iterative gate parked on a human decision after spending
//                          its automatic budget (a quality companion at its rework cap,
//                          or the requirements reviewer at its iteration cap). Without
//                          this the three-choice decision is reachable only by drilling
//                          into the parked step, so the run looks silently stuck; acting
//                          on it opens that step's decision surface.
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
export const notificationTypeSchema = v.picklist([
  'merge_review',
  'pipeline_complete',
  'ci_failed',
  'test_failed',
  'requirement_review',
  'clarity_review',
  'release_regression',
  'decision_required',
  'human_test_ready',
  'visual_confirmation_ready',
  'human_review',
  'followup_pending',
  'fork_decision_pending',
  'pr_review_ready',
  'initiative',
])
export type NotificationType = v.InferOutput<typeof notificationTypeSchema>

/**
 * Lifecycle of a notification: `open` until a human engages, terminal `acted`
 * once its action ran (merged, confirmed, retried…), or `dismissed` when waved
 * off. Only `open` notifications surface on the board.
 */
export const notificationStatusSchema = v.picklist(['open', 'acted', 'dismissed'])
export type NotificationStatus = v.InferOutput<typeof notificationStatusSchema>

/**
 * How urgently a notification is rendered. A notification starts `normal` (the
 * inbox's usual per-type color) and is escalated to `urgent` (red) by the periodic
 * sweep once it has been waiting for a human longer than the workspace's
 * `waitingEscalationMinutes` threshold. This is the run-timing signal that replaced
 * the old hard "decision timeout" auto-fail: runs now wait indefinitely, and the
 * notification colour — not a killed run — conveys that a human is overdue.
 */
export const notificationSeveritySchema = v.picklist(['normal', 'urgent'])
export type NotificationSeverity = v.InferOutput<typeof notificationSeveritySchema>

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
  /** Number of open findings, on a `requirement_review`. */
  findingCount: v.optional(v.number()),
  /** Number of materially different implementation forks surfaced, on a `fork_decision_pending`. */
  forkCount: v.optional(v.number()),
  /** Number of cohesive slices the PR was grouped into, on a `pr_review_ready`. */
  sliceCount: v.optional(v.number()),
  /** The `on-call` agent's assessment, on a `release_regression`. */
  onCallAssessment: v.optional(onCallAssessmentSchema),
  /** The monitors/SLOs that regressed, on a `release_regression`. */
  releaseSignals: v.optional(v.array(releaseSignalSchema)),
  /** Web URL of a proposed revert PR the human can open/merge, when known. */
  revertUrl: v.optional(v.string()),
  /**
   * Internal user id (`usr_*`) of the member this notification is directed at — the
   * task's responsible product person on a `requirement_review`. The inbox highlights
   * it as "for you"; the notification stays workspace-visible to everyone.
   */
  targetUserId: v.optional(v.nullable(v.string())),
  /** Why the initiative loop raised the card, on an `initiative` notification. */
  initiativeReason: v.optional(v.picklist(['item_blocked', 'complete', 'checkpoint'])),
  /**
   * On a `merge_review` raised for a PARTIALLY-merged multi-repo task (service-connections
   * phase 4): the repos whose PRs DID merge before an intermediate merge failed. Cross-repo
   * merges cannot be atomic, so the human finishes or reverts the split by hand.
   */
  mergedRepos: v.optional(v.array(v.string())),
  /** The repos whose PRs are still UNMERGED after a partial multi-repo merge (see {@link mergedRepos}). */
  unmergedRepos: v.optional(v.array(v.string())),
})
export type NotificationPayload = v.InferOutput<typeof notificationPayloadSchema>

/** A human-actionable item surfaced on the board. */
export const notificationSchema = v.object({
  id: v.string(),
  type: notificationTypeSchema,
  status: notificationStatusSchema,
  /**
   * Render urgency (see {@link notificationSeveritySchema}). Absent ⇒ `normal`. Flipped
   * to `urgent` by the escalation sweep once it has waited past the workspace threshold.
   */
  severity: v.optional(notificationSeveritySchema),
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
