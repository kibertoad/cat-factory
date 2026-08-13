import * as v from 'valibot'
import { gateApprovalRecordSchema, gateApproverPolicySchema } from './gate-config.js'

// ---------------------------------------------------------------------------
// The HUMAN decisions a run's step can be holding: a question an agent raised, the review comments
// a person or a quality companion left on an output, a companion's stored verdict, and the approval
// gate a step parks on.
//
// Split out of `execution.ts` (which keeps the run/step runtime state that COMPOSES these), for the
// same reason `gate.ts` and `human-verdict-gates.ts` are separate: they are one cohesive cluster,
// they are what a decision-answering surface reads, and `execution.ts` is at its size budget. Both
// files are re-exported from the package barrel, so consumers are unaffected. This file depends
// only on `gate-config.ts` (the per-step gate configuration an approval gate snapshots when it is
// raised), never on `execution.ts`: that one composes this, not the other way round.
// ---------------------------------------------------------------------------

/**
 * A question an agent raised mid-work and would not answer unilaterally. Unlike an approval gate
 * (which fires AFTER a step produced its output), resolving a decision RE-RUNS the same step with
 * the choice folded in. `chosen` is null while the run is parked on it.
 */
export const decisionSchema = v.object({
  id: v.string(),
  question: v.string(),
  options: v.array(v.string()),
  chosen: v.nullable(v.string()),
})
export type Decision = v.InferOutput<typeof decisionSchema>

/**
 * How urgently a review comment must be acted on, worst first. The three levels are the ones a
 * reviewer already writes as prose group labels ("Must fix" / "Should fix" / "Minor"), promoted to
 * a field so the ENGINE can act on them rather than a human having to read the summary to find out
 * what blocks the work.
 *
 * `blocker` is the load-bearing member and the only one with mechanical force: while a companion's
 * latest verdict carries one, the producer is reworked and the run does not advance past the step,
 * whatever the overall rating says (see {@link hasBlockingReviewComments} and kernel's
 * `disposeCompanionVerdict`). A rating is one number over a whole deliverable, so a review that
 * found something genuinely unshippable could still average above the bar and be waved through;
 * that is the gap this closes. `major` and `minor` differ only in how a reader (and a reworking
 * producer) should prioritise them.
 */
export const reviewCommentSeveritySchema = v.picklist(['blocker', 'major', 'minor'])
export type ReviewCommentSeverity = v.InferOutput<typeof reviewCommentSeveritySchema>

/** Rank of a {@link ReviewCommentSeverity}, for worst-first ordering and "at or above" tests. */
export const REVIEW_COMMENT_SEVERITY_RANK: Record<ReviewCommentSeverity, number> = {
  minor: 0,
  major: 1,
  blocker: 2,
}

/**
 * One GitHub-review-style comment left on a specific block or item of an agent's
 * proposal — either by a human reviewing an approval gate, or by a quality
 * companion (e.g. the Spec Reviewer) grading a structured output. `quotedSource`
 * is the verbatim raw markdown of the block the comment targets (sliced from the
 * proposal by its source line range), so a "request changes" re-run can quote the
 * agent's own text back to it rather than a re-rendered approximation. It is
 * OPTIONAL because a comment may instead anchor to a structured item via
 * {@link anchorId} (e.g. a spec requirement / acceptance-criterion id), where the
 * reviewed output is rendered as discrete items rather than free prose and there is
 * no quoted source range — the shape a companion returns.
 */
export const stepReviewCommentSchema = v.object({
  /**
   * Verbatim raw-markdown source of the commented prose block. Optional: a comment
   * may instead anchor to a structured item via {@link anchorId}, where there is no
   * prose source to quote.
   */
  quotedSource: v.optional(v.string()),
  /**
   * 0-based source line range [start, end) of the commented prose block, for
   * best-effort re-anchoring. Optional: a comment may instead anchor to a structured
   * item via {@link anchorId} (e.g. a spec requirement/acceptance-criterion id), where
   * there is no prose line range.
   */
  srcStart: v.optional(v.number()),
  srcEnd: v.optional(v.number()),
  /**
   * Stable id of the structured item the comment targets (e.g. a spec
   * requirement/criterion id), when the reviewed output is rendered as structured
   * items rather than free prose. Absent for prose-range comments.
   */
  anchorId: v.optional(v.string()),
  /**
   * How urgently this point must be acted on (see {@link reviewCommentSeveritySchema}).
   *
   * Absent on a HUMAN's comment, which carries no such grading: a person requesting changes on an
   * approval gate is already holding the run, so there is nothing for a severity to decide. Absent
   * too on a comment recorded before this field existed. An absent severity is therefore read as
   * "ungraded", NEVER as a blocker and never as a nit — the one reader that acts on the value
   * ({@link hasBlockingReviewComments}) asks only whether a `blocker` is present.
   *
   * An out-of-vocabulary value from a model reads as `major`, the same "unreadable severity reads
   * as its safe default" rule the judge and PR-review findings use. `major` rather than either
   * extreme on purpose: a typo must not manufacture a hard stop, and it must not silently retire
   * one either, so it lands where the point still costs a rework round without holding the run.
   */
  severity: v.optional(v.fallback(reviewCommentSeveritySchema, 'major')),
  /** The reviewer's note on this block / item. */
  body: v.string(),
})
export type StepReviewComment = v.InferOutput<typeof stepReviewCommentSchema>

/**
 * The comments that MUST be fixed before the work moves on, worst-first-ordered input aside.
 *
 * The pure rule, in contracts rather than in the engine, because both sides have to agree about
 * it: the engine decides whether the run advances, and the SPA states on the parked step WHY it
 * stopped and which points to look at. Restated on each side, the panel would eventually count
 * findings the engine did not.
 */
export function blockingReviewComments(
  comments: readonly StepReviewComment[] | undefined,
): StepReviewComment[] {
  return (comments ?? []).filter((comment) => comment.severity === 'blocker')
}

/** Whether any of `comments` is a `blocker` (see {@link blockingReviewComments}). */
export function hasBlockingReviewComments(
  comments: readonly StepReviewComment[] | undefined,
): boolean {
  return (comments ?? []).some((comment) => comment.severity === 'blocker')
}

/** `comments` ordered worst severity first; an ungraded comment sorts last. Stable within a level. */
export function bySeverityWorstFirst(
  comments: readonly StepReviewComment[],
): StepReviewComment[] {
  const rank = (comment: StepReviewComment) =>
    comment.severity ? REVIEW_COMMENT_SEVERITY_RANK[comment.severity] : -1
  return [...comments].sort((a, b) => rank(b) - rank(a))
}

/**
 * The standardized, stored verdict a quality companion produced for an output it
 * graded — shared by every companion site (the pipeline companion step and the
 * requirements-rework gate). The raw model response is {@link companionAssessmentSchema}
 * (rating + summary + comments); this is the persisted, self-describing record of how
 * that assessment was applied: the `rating`, the `threshold` it was judged against,
 * whether it `passed`, and the `feedback` surfaced to the human / fed into a rework.
 */
export const companionVerdictSchema = v.object({
  /** Overall quality of the graded output (0..1, higher = better). */
  rating: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  /** The quality bar the rating had to reach to pass. */
  threshold: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  /** Whether the rating met the threshold. */
  passed: v.boolean(),
  /** The companion's challenge / justification (its assessment summary). */
  feedback: v.string(),
  /**
   * The per-item challenges this round anchored (the assessment's own `comments`).
   *
   * Stored, rather than left to the summary alone, because the verdict list is what a LATER round
   * is shown: a companion re-grades a document it has already reviewed, and the question worth
   * spending a rework budget on is "was what I asked for done", which it cannot answer against a
   * summary that named none of the specific asks. The producer is handed the same list for the
   * mirror-image reason — so it cannot regress on a point raised two rounds ago and forgotten.
   *
   * Absent on a round that anchored nothing, and on every verdict written before this existed.
   *
   * Their SEVERITIES are what makes the verdict self-describing: `passed: false` on a round whose
   * rating cleared `threshold` is only readable next to the `blocker` that held it (see
   * {@link reviewCommentSeveritySchema}).
   */
  comments: v.optional(v.array(stepReviewCommentSchema)),
})
export type CompanionVerdict = v.InferOutput<typeof companionVerdictSchema>

/**
 * An approval gate's lifecycle: `pending` while awaiting the human; terminal
 * `approved`/`rejected`; `changes_requested` re-runs the step. Named (rather
 * than inlined in {@link stepApprovalSchema}) because the public decision
 * projection reports the same states, and two picklists spelling one lifecycle
 * is how the SPA and the API end up disagreeing about what `pending` means.
 */
export const stepApprovalStatusSchema = v.picklist([
  'pending',
  'approved',
  'changes_requested',
  'rejected',
])
export type StepApprovalStatus = v.InferOutput<typeof stepApprovalStatusSchema>

/**
 * A human approval gate raised after a step whose pipeline marked it
 * `requiresApproval`. Unlike a {@link Decision} (which an agent raises and which
 * re-runs the same step on resolution), an approval gate fires once the step has
 * already produced its `proposal`; approving advances the run (carrying the —
 * possibly edited — proposal forward as context), requesting changes re-runs the
 * same step with the human's `feedback` (+ per-block `comments`), and rejecting
 * stops the run entirely (a terminal `rejected` failure the board can retry).
 *
 * It is also the engine's GENERIC parking mechanism, which is the trap for anything that reads it:
 * a review gate, a brainstorm, a fork choice, a human-verdict gate, a follow-up triage and an
 * interview all leave a `pending` approval here while being driven by their own verbs entirely.
 * "This step has a pending approval" therefore does NOT mean "this is an approval gate"; the
 * engine's `dedicatedParkSurface` is what tells the two apart.
 */
export const stepApprovalSchema = v.object({
  /** Unique id of this gate; the durable run parks on it like a decision. */
  id: v.string(),
  /** `pending` while awaiting the human; terminal `approved`/`rejected`; `changes_requested` re-runs the step. */
  status: stepApprovalStatusSchema,
  /** The agent's output the human is reviewing (editable before approval). */
  proposal: v.string(),
  /** When changes were requested, the human's freeform guidance fed into the re-run. */
  feedback: v.optional(v.string()),
  /** When changes were requested, per-block review comments fed into the re-run. */
  comments: v.optional(v.array(stepReviewCommentSchema)),
  /**
   * How many distinct approvals this gate needs before the run advances, SNAPSHOTTED from the
   * step's `stepOptions.gateConfig.minApprovals` when the gate was raised. Absent ⇒ 1.
   *
   * Snapshotted rather than re-read on each approval for the reason a run's merge role is pinned
   * at admission: the pipeline definition is editable while a run is parked on it, and a bar that
   * moved under the people already counted toward it is a bar nobody agreed to.
   */
  requiredApprovals: v.optional(v.number()),
  /**
   * Who may resolve this gate, snapshotted alongside {@link requiredApprovals}. Absent ⇒ anyone
   * the workspace RBAC gate admits to write. See {@link gateApproverPolicySchema}.
   */
  approverPolicy: v.optional(gateApproverPolicySchema),
  /**
   * The approvals recorded so far, one per distinct identity, oldest first. Reaching
   * {@link requiredApprovals} entries is what flips `status` to `approved`; below it the gate
   * stays `pending` and the run stays parked. Absent/empty on a gate nobody has cleared yet.
   */
  approvals: v.optional(v.array(gateApprovalRecordSchema)),
})
export type StepApproval = v.InferOutput<typeof stepApprovalSchema>
