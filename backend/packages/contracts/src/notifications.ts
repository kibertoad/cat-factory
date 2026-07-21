import * as v from 'valibot'
import { mergeAssessmentSchema } from './merge.js'
import { platformAlertReasonSchema, platformObservabilityWindowSchema } from './observability.js'
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
//   - `platform_health`  — the platform-health sweep found the deployment's own aggregate
//                          run health crossed an operator threshold (elevated failure rate,
//                          slow-run tail, or backlog depth) for an account. NOT block-scoped
//                          (blockId is null) — it concerns the whole deployment; it auto-clears
//                          when the account recovers, and re-notifies only when the firing set
//                          of conditions changes (not every sweep). Informational: clicking it
//                          opens the operator dashboard; `act` just marks it read.
//   - `budget_paused`    — one or more runs were paused by the spend safeguard (the workspace,
//                          account, or user budget is exhausted). Workspace-scoped (one card,
//                          not one per run) and purely informational: the sweeper never re-drives
//                          a `paused` run, so without this card the ONLY signal is the paused
//                          badge on the board. Raise the budget then resume from the spend panel;
//                          `act` just marks it read.
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
  'platform_health',
  'budget_paused',
  'key_drift',
])
export type NotificationType = v.InferOutput<typeof notificationTypeSchema>

/**
 * One credential the ENCRYPTION_KEY-drift sweep (ADR 0026 D6.2) could not decrypt, carried on a
 * `key_drift` notification. NEVER carries the secret value — only its non-secret identity (source
 * table, row id, a human label) plus WHY it failed, so the surfaced issue is legible and the
 * operator's drop/re-seal action (D6.3) can target a specific one.
 */
export const keyDriftAffectedSchema = v.object({
  /** The store the secret lives in, e.g. `'environment_connection'` / `'observability_connection'`. */
  source: v.string(),
  /** The owning row's id — the target of the drop action. */
  id: v.string(),
  /** A human label (connection type / provider) for the card. */
  label: v.string(),
  /**
   * Why it failed: `key-mismatch` (sealed under a different ENCRYPTION_KEY — unrecoverable without
   * it) or `corrupt` (malformed/foreign envelope — a separate fault). Only `key-mismatch` is true
   * key drift; both are surfaced so a corrupt row isn't misread as a key change.
   */
  reason: v.picklist(['key-mismatch', 'corrupt']),
  /** Epoch ms the secret was sealed, when known — helps an operator correlate a key change. */
  sealedAt: v.nullable(v.number()),
})
export type KeyDriftAffected = v.InferOutput<typeof keyDriftAffectedSchema>

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
  /** The window the aggregate was computed over, on a `platform_health` notification. */
  platformWindow: v.optional(platformObservabilityWindowSchema),
  /**
   * On a `platform_health` notification: the alert conditions currently firing, sorted. This
   * is the card's dedup identity — the sweep re-raises the SAME card every pass, but the
   * service only re-delivers when this set (hence the content) changes, so a persistently
   * unhealthy deployment doesn't re-toast the inbox on every sweep. Live per-condition NUMBERS
   * are deliberately NOT carried here (they fluctuate every sweep and live on the dashboard the
   * card links to); the reason set + window are enough to convey "what's wrong, go look".
   */
  platformAlerts: v.optional(v.array(platformAlertReasonSchema)),
  /**
   * On a `key_drift` notification: the stored credentials the drift sweep could not decrypt
   * (never their values). This is the card's dedup identity — the sweep re-raises the SAME card
   * each run but only re-delivers when this set changes — AND the list the drop/re-seal action
   * (D6.3) targets. Sorted by `(source, id)` so the identity is stable across sweeps.
   */
  driftAffected: v.optional(v.array(keyDriftAffectedSchema)),
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

// Remediation of a drifted sealed credential (ADR 0026 D6.3) is explicit + per-secret but has NO
// HTTP contract: the in-app `key_drift` card action drops every credential it lists (batch), and
// the `key-drift:drop` operator CLI drops a single `(source, id)`. Neither takes a wire body, so
// there is deliberately no `dropKeyDriftSecret*` schema here — add one only if a per-secret HTTP
// drop endpoint is introduced.
