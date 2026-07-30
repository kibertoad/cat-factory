import type { PipelineStep, PrReviewSliceReview } from '@cat-factory/kernel'
import { parsePrReviewSliceReview } from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// Per-slice PR-review capture: fold the harness's live slice reviews onto the `pr-reviewer` step.
//
// WHY THIS FILE EXISTS. A PR review fans its slices out across parallel subagents and emits
// `slices`/`findings` only in its TERMINAL structured output. Everything in between was previously
// unpersisted, so a review that died mid-run (or whose aggregation pass wedged, the motivating
// incident) threw away every finished slice and could only be re-run from zero. The harness now
// captures each slice's subagent report as it lands; this module makes it durable on the step, which
// is the prerequisite for resuming a stuck review for only the slices that never finished.
//
// Pure: no engine state, no IO. The fold is idempotent (the harness republishes the WHOLE set on
// every poll, latest-wins), which is what lets a dropped poll response cost nothing.
// ---------------------------------------------------------------------------

/** Lenient parse of one harness-reported slice review; `null` when unusable. */
function coerceSliceReview(raw: unknown): PrReviewSliceReview | null {
  const parsed = parsePrReviewSliceReview(raw)
  if (!parsed) return null
  // A label is the only field a resume can key on: an unlabelled slice can be neither paired with
  // the reviewer's plan nor named in the prior-review context, so it is noise.
  if (!parsed.label.trim()) return null
  return parsed
}

/**
 * Parse the harness payload into slice reviews, dropping unusable entries.
 *
 * Deliberately lenient per ENTRY rather than all-or-nothing: one malformed slice must not discard
 * the seven good reports beside it, since discarding them is exactly the data loss this channel
 * exists to prevent.
 */
export function coerceSliceReviews(raw: unknown): PrReviewSliceReview[] {
  if (!Array.isArray(raw)) return []
  const reviews: PrReviewSliceReview[] = []
  for (const entry of raw) {
    const review = coerceSliceReview(entry)
    if (!review) continue
    // The reviewer can dispatch the same slice label twice (a retried subagent). Keep the
    // completed one whichever order they arrive in: a later in-flight duplicate must not demote a
    // slice that already reported, or a resume would re-review work it already holds.
    const key = review.label.trim()
    const existing = reviews.findIndex((r) => r.label.trim() === key)
    if (existing >= 0) {
      if (reviews[existing]!.status !== 'completed' && review.status === 'completed') {
        reviews[existing] = review
      }
      continue
    }
    reviews.push(review)
  }
  return reviews
}

/** Whether two slice-review sets are equivalent, so an unchanged republish writes nothing. */
function sameSliceReviews(a: PrReviewSliceReview[], b: PrReviewSliceReview[]): boolean {
  if (a.length !== b.length) return false
  return a.every((left, i) => {
    const right = b[i]!
    return (
      left.label === right.label &&
      left.status === right.status &&
      (left.report ?? null) === (right.report ?? null)
    )
  })
}

/**
 * Fold the harness's live per-slice reviews onto a `pr-reviewer` step, returning whether anything
 * changed.
 *
 * Only applies to a step that already carries `prReview` (the reviewer seeds it at dispatch): the
 * channel is review-specific, and a subagent-fanning coder step must not grow review state. Absent
 * or unparseable payloads leave the step untouched.
 *
 * NEVER shrinks the set. The harness republishes everything it has captured, but a poll can be
 * served by a RESTARTED container (a resume, an eviction retry) whose tracker only knows the slices
 * IT dispatched — forwarding that verbatim would erase the previous attempt's reports, which are
 * the whole point. So completed reports already on the step survive a set that no longer mentions
 * them.
 */
export function applySliceReviews(step: PipelineStep, raw: unknown): boolean {
  if (!step.prReview) return false
  const incoming = coerceSliceReviews(raw)
  if (incoming.length === 0) return false
  const merged = mergeSliceReviews(step.prReview.sliceReviews ?? [], incoming)
  if (sameSliceReviews(step.prReview.sliceReviews ?? [], merged)) return false
  step.prReview = { ...step.prReview, sliceReviews: merged }
  return true
}

/**
 * Merge freshly-reported slice reviews over what the step already holds, keyed by label.
 *
 * Monotonic in two directions, both of which matter across a resume: a slice already `completed`
 * with a report is never demoted to `in_progress` (the resumed container re-dispatches it as new
 * before its own subagent returns), and a slice the step knows about but this attempt never
 * mentioned is kept rather than dropped.
 */
export function mergeSliceReviews(
  existing: PrReviewSliceReview[],
  incoming: PrReviewSliceReview[],
): PrReviewSliceReview[] {
  const byLabel = new Map<string, PrReviewSliceReview>()
  for (const review of existing) byLabel.set(review.label.trim(), review)
  for (const review of incoming) {
    const key = review.label.trim()
    const prior = byLabel.get(key)
    // A completed report is terminal for that slice; only an upgrade to completed replaces it.
    if (prior?.status === 'completed' && review.status !== 'completed') continue
    byLabel.set(key, review)
  }
  return [...byLabel.values()]
}
