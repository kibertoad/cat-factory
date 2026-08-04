import * as v from 'valibot'
import { mergeAssessmentSchema } from './merge.js'
import { infraSetupAreaSchema } from './infra-setup.js'
import {
  platformAlertReasonSchema,
  platformAlertWindowSchema,
  platformFailingRunSchema,
} from './observability.js'
import { changeClassSchema, reviewEffortSchema } from './mergeTrackRecord.js'
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
//   - `merge_tag_request`— a pull request cat-factory opened was merged DIRECTLY on the VCS
//                          provider (bypassing the merge card), so the merge track record has
//                          no reviewer-effort tag. A lightweight, dismissible nudge asking for
//                          one tap; it gates nothing and the record stays valid untagged.
//   - `infra_unreachable`— the reachability watcher found a CONFIGURED infrastructure area (the
//                          ephemeral-environment provider, the self-hosted runner pool) that no
//                          longer answers its connection probe, so a class of agents cannot run.
//                          NOT block-scoped: it concerns the whole workspace. It auto-clears when
//                          every area answers again, and re-notifies only when the set of
//                          unreachable areas changes (not every sweep). The card doubles as the
//                          watcher's durable record of the last observed state, which is what lets
//                          the sweep publish `infraSetup` on transitions only; `act` marks it read.
//   - `budget_paused`    — one or more runs were paused by the spend safeguard (the workspace,
//                          account, or user budget is exhausted). Workspace-scoped (one card,
//                          not one per run) and purely informational: the sweeper never re-drives
//                          a `paused` run, so without this card the ONLY signal is the paused
//                          badge on the board. Raise the budget then resume from the spend panel;
//                          `act` just marks it read.
//   - `budget_threshold`: the spend-forecast sweep found a workspace's (or its account's) metered
//                          spend has crossed an alert threshold of the monthly budget, or is
//                          projected to overrun it before the period ends. The PROACTIVE
//                          counterpart to `budget_paused`, which only arrives once runs are
//                          already being paused: this one fires while there is still time to
//                          raise the limit or stop a runaway. Workspace-scoped and purely
//                          informational; it re-arms at the period rollover.
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
  'judge_review',
  'pr_review_ready',
  'initiative',
  'platform_health',
  'infra_unreachable',
  'budget_paused',
  'budget_threshold',
  'key_drift',
  'merge_tag_request',
])
export type NotificationType = v.InferOutput<typeof notificationTypeSchema>

/**
 * The closed set of notification types that count as "a task is waiting on a human review"
 * for the opt-in review-debt friction feature (see `backend/docs/review-debt-friction.md`).
 * Every entry is a human-parking surface that raises an open card carrying a `blockId` +
 * `createdAt`; the friction verdict derives its debt list from open notifications of these
 * types. It is the single source of truth shared by the frontend, the pure verdict function
 * (`assessReviewFriction`), and the backend enforcement point — adding a new human-parking
 * surface to the debt definition is a one-line change reviewed like any other contract change.
 *
 * Deliberately EXCLUDED: failure-remediation cards (`ci_failed`, `test_failed`,
 * `release_regression`) — "the machine needs help", not "a human owes a review" — and
 * block-less/system cards (`platform_health`, `infra_unreachable`, `budget_paused`,
 * `budget_threshold`, `key_drift`, `initiative`) that aren't tied to a reviewable task. `merge_tag_request` is excluded too: the PR
 * it concerns has ALREADY merged, so it is a post-hoc nudge for one tap — counting it as review
 * debt would friction task authoring over work that is finished.
 */
export const REVIEW_WAIT_NOTIFICATION_TYPES = [
  'merge_review',
  'pipeline_complete',
  'requirement_review',
  'clarity_review',
  'decision_required',
  'human_test_ready',
  'visual_confirmation_ready',
  'human_review',
  'followup_pending',
  'fork_decision_pending',
  'judge_review',
  'pr_review_ready',
] as const satisfies readonly NotificationType[]

export type ReviewWaitNotificationType = (typeof REVIEW_WAIT_NOTIFICATION_TYPES)[number]

const REVIEW_WAIT_NOTIFICATION_TYPE_SET: ReadonlySet<NotificationType> = new Set(
  REVIEW_WAIT_NOTIFICATION_TYPES,
)

/** Whether a notification type counts as a task waiting on human review (see above). */
export function isReviewWaitNotificationType(type: NotificationType): boolean {
  return REVIEW_WAIT_NOTIFICATION_TYPE_SET.has(type)
}

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
 * Which budget tier a `budget_threshold` alert concerns. The USER tier is deliberately absent:
 * a personal budget is not a fact a workspace-visible card may state, and there is no per-user
 * inbox to raise it in. Warning an individual before their own budget runs out is a separate
 * surface (see the spend-forecasting tracker), not a member of this vocabulary.
 */
export const budgetAlertTierSchema = v.picklist(['workspace', 'account'])
export type BudgetAlertTier = v.InferOutput<typeof budgetAlertTierSchema>

/**
 * One firing budget tier on a `budget_threshold` card. STATE only (see
 * {@link notificationPayloadSchema.budgetAlerts}): both fields are stable for as long as the
 * tier's situation is unchanged, which is what lets the sweep re-raise the same card every pass
 * without re-delivering it.
 */
export const budgetAlertSchema = v.object({
  tier: budgetAlertTierSchema,
  /**
   * The highest alert threshold this tier's ACTUAL spend has crossed, as a fraction of the
   * limit (e.g. `0.8`). Null when nothing is crossed and only the projection fired.
   */
  threshold: v.nullable(v.number()),
  /**
   * Whether the tier is PROJECTED to exceed its limit before the period ends while actual
   * spend has not yet reached it. The forward-looking half of the alert: a board can be at 30%
   * on the 10th and still be on pace to overrun.
   */
  projectedOverrun: v.boolean(),
})
export type BudgetAlert = v.InferOutput<typeof budgetAlertSchema>

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
  platformWindow: v.optional(platformAlertWindowSchema),
  /**
   * On a `platform_health` notification: the alert conditions currently firing, sorted. This
   * is the card's dedup identity: the sweep raises the card only when this set CHANGES, so a
   * persistently unhealthy deployment doesn't re-toast the inbox on every sweep. Live
   * per-condition NUMBERS are deliberately NOT carried here (they fluctuate every sweep and
   * live on the dashboard the card links to); the reason set + window convey "what's wrong".
   */
  platformAlerts: v.optional(v.array(platformAlertReasonSchema)),
  /**
   * On a `platform_health` notification whose firing set includes `failure_kind_rate_high`: the
   * failure kinds whose per-kind rule is firing, sorted. Absent when no per-kind rule is.
   *
   * The SECOND half of the card's dedup identity, and it has to be, because the reason code is
   * shared by every per-kind rule: with the reasons alone, evictions subsiding while timeouts
   * took over would leave the firing set looking untouched, and the card would go on naming the
   * incident that had ended. It is a set of NAMES rather than numbers for the same reason the
   * reasons are: a share that drifts each sweep would re-toast the inbox for a whole incident.
   */
  platformAlertFailureKinds: v.optional(v.array(v.string())),
  /**
   * On a `platform_health` notification whose firing set includes a failure condition: a
   * bounded sample of the runs the alert is aggregating, in THIS workspace, so the card
   * deep-links to the evidence instead of only to the dashboard. Newest first.
   *
   * It rides the payload (the card's dedup identity) precisely because it is captured once,
   * when the firing set changes, rather than refreshed each sweep: a list that churned with
   * every new failure would re-deliver the card for the whole incident, which is the failure
   * mode the reason-set identity exists to prevent. The runs are therefore the ones that were
   * failing WHEN THE ALERT FIRED, and the dashboard behind the card is the live view.
   */
  platformFailingRuns: v.optional(v.array(platformFailingRunSchema)),
  /**
   * How many runs in this workspace had failed in the window when the card was raised.
   * Reported alongside the capped {@link platformFailingRuns} sample so the card states what
   * it left out ("5 of 23") rather than presenting the cap as the whole story.
   */
  platformFailedTotal: v.optional(v.number()),
  /**
   * On a `platform_health` notification: which TRANSITION of this incident the card is showing,
   * counting from 1 at the edge that opened it and incrementing every time the firing set
   * changes while it stays open.
   *
   * It is bookkeeping rather than content, and the card renders none of it. It lives here
   * because the card row is the sweep's ONLY store of alert state, and the outbound
   * `platform_health.firing` edge needs an identity for a transition that neither of the card's
   * other identities can give it: the card id is reused for the whole incident, and the reason
   * set RECURS within one ({A} escalating to {A,B} and subsiding to {A} is three transitions
   * over two distinct sets). Deriving it from the prior card rather than from a clock is what
   * makes two sweepers racing on the same transition compute the SAME ordinal, so a receiver
   * still collapses them, which a timestamp, differing per process, would not.
   */
  platformAlertTransition: v.optional(v.number()),
  /**
   * On an `infra_unreachable` notification: the configured infrastructure areas whose live probe
   * is currently failing, sorted. Like {@link platformAlerts} this is the card's dedup identity —
   * the watcher re-raises the SAME card every pass and the service only re-delivers when the set
   * changes — AND the record the snapshot projection folds back into `infraSetup`, so a reload
   * mid-outage still renders the banner without re-probing on the board-load path.
   *
   * The per-area probe REASON is deliberately not carried: it varies between passes (a refused
   * connection, then a timeout), and any content change re-delivers the card, so persisting it
   * would re-toast the inbox for the whole outage. It rides the live `infraSetup` event instead.
   */
  unreachableAreas: v.optional(v.array(infraSetupAreaSchema)),
  /**
   * On a `key_drift` notification: the stored credentials the drift sweep could not decrypt
   * (never their values). This is the card's dedup identity — the sweep re-raises the SAME card
   * each run but only re-delivers when this set changes — AND the list the drop/re-seal action
   * (D6.3) targets. Sorted by `(source, id)` so the identity is stable across sweeps.
   */
  driftAffected: v.optional(v.array(keyDriftAffectedSchema)),
  /**
   * On a `budget_threshold` notification: the billing period the alert belongs to (epoch ms,
   * UTC month start). Part of the card's dedup identity, and the field that RE-ARMS every
   * signal below at the period rollover. Without it, a workspace that crossed 80% in July
   * would look "already notified" for August's first crossing too.
   */
  budgetPeriodStart: v.optional(v.number()),
  /**
   * On a `budget_threshold` notification: which budget tiers are firing and how, sorted by
   * tier. The card's dedup identity, so it carries only STATE (the threshold crossed, whether
   * the projection overruns) and never live figures: spend and burn rate move on every sweep,
   * and any payload change re-delivers the card, so putting the interesting number here would
   * re-toast the inbox every few minutes for the rest of the month. The figures live on the
   * Usage surface the card points at.
   */
  budgetAlerts: v.optional(v.array(budgetAlertSchema)),
  /**
   * The run's deterministic change class, on a `merge_review` / `pipeline_complete` /
   * `merge_tag_request` card — so the human sees WHAT KIND of change they are being asked to
   * review or tag, and the SPA can show that class's accumulated track record alongside.
   */
  changeClass: v.optional(changeClassSchema),
  /**
   * The merge track record the card's effort tag applies to. Carried on the merge-decision
   * cards (so acting on one can tag in the same tap) and on a `merge_tag_request` (whose whole
   * purpose is to tag it). Absent when no record was written (a best-effort side channel).
   */
  mergeTrackRecordId: v.optional(v.string()),
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

/**
 * Body of `POST /notifications/:id/act`. Every field is optional, so `{}` is the historical
 * no-body behaviour.
 *
 * On a `merge_review` / `pipeline_complete` card, `reviewEffort` records — in the SAME tap that
 * confirms the merge — how much review the PR actually needed, onto the run's merge track
 * record. Omitting it is always fine: the record keeps a null tag and nothing downstream breaks
 * (tagging is a nudge, never a gate).
 */
export const actNotificationSchema = v.object({
  reviewEffort: v.optional(v.nullable(reviewEffortSchema)),
})
export type ActNotificationInput = v.InferOutput<typeof actNotificationSchema>

// Remediation of a drifted sealed credential (ADR 0026 D6.3) is explicit + per-secret but has NO
// HTTP contract: the in-app `key_drift` card action drops every credential it lists (batch), and
// the `key-drift:drop` operator CLI drops a single `(source, id)`. Neither takes a wire body, so
// there is deliberately no `dropKeyDriftSecret*` schema here — add one only if a per-secret HTTP
// drop endpoint is introduced.
