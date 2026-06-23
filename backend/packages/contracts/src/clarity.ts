import * as v from 'valibot'
import { iterationCapChoiceSchema } from './iteration-cap.js'
import { requirementReviewItemSchema, requirementReviewStatusSchema } from './requirements.js'

// ---------------------------------------------------------------------------
// Clarity-review wire contracts. A clarity reviewer triages a board block's BUG
// REPORT — its description plus any context an upstream `bug-investigator` step
// enriched it with — for *fixability*: are the repro steps, expected-vs-actual
// behaviour, environment, affected area and scope clear enough to act on? It
// raises review items (the same shape as the requirements reviewer's) each with a
// severity. A human answers or dismisses each; an incorporation companion folds the
// answers into ONE standardized, clear bug report, then the reviewer re-reviews it.
// The cycle repeats until the reviewer is clean (or every remaining finding is
// dismissed / tolerated by the task's severity threshold), or the task's iteration
// cap is hit and a human picks how to proceed.
//
// This is the requirements-review flow applied to a different subject, so it REUSES
// the requirements review item + status shapes (one source of truth) and differs
// only in subject and in the persisted document field name (`clarifiedReport`).
// ---------------------------------------------------------------------------

/** A single triage finding the clarity reviewer raised — same shape as a requirements item. */
export const clarityReviewItemSchema = requirementReviewItemSchema
export type ClarityReviewItem = v.InferOutput<typeof clarityReviewItemSchema>

/** Lifecycle of a clarity review as a whole — identical to the requirements review lifecycle. */
export const clarityReviewStatusSchema = requirementReviewStatusSchema
export type ClarityReviewStatus = v.InferOutput<typeof clarityReviewStatusSchema>

/** A clarity (bug-report triage) review for one board block. */
export const clarityReviewSchema = v.object({
  id: v.string(),
  blockId: v.string(),
  status: clarityReviewStatusSchema,
  items: v.array(clarityReviewItemSchema),
  /** `provider:model` that produced the review, for transparency; null in tests. */
  model: v.nullable(v.string()),
  /**
   * The clarified bug report the incorporation companion last folded the answers into.
   * Set once a doc has been produced (status `merged`/`incorporated`); null while still
   * awaiting answers on the first pass. Consumed by every downstream agent step + the
   * spec-writer once the phase is settled.
   */
  clarifiedReport: v.nullable(v.string()),
  /** How many reviewer passes have run so far (the initial review is iteration 1). */
  iteration: v.optional(v.number(), 1),
  /** The reviewer-pass budget, snapshotted from the task's merge preset when the review started. */
  maxIterations: v.optional(v.number(), 1),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type ClarityReview = v.InferOutput<typeof clarityReviewSchema>

// ---- Request bodies -------------------------------------------------------

/** Record a human's answer to a single clarity review item. */
export const replyClarityItemSchema = v.object({
  reply: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4000)),
})
export type ReplyClarityItemInput = v.InferOutput<typeof replyClarityItemSchema>

/** Set a clarity review item's status (resolve / dismiss / reopen). */
export const updateClarityItemStatusSchema = v.object({
  status: v.picklist(['open', 'answered', 'resolved', 'dismissed']),
})
export type UpdateClarityItemStatusInput = v.InferOutput<typeof updateClarityItemStatusSchema>

/**
 * Incorporate the settled answers into a standardized, clear bug report. An optional
 * `feedback` comment is the human's "do it differently" lever when redoing a merge.
 */
export const incorporateClaritySchema = v.object({
  feedback: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(4000))),
})
export type IncorporateClarityInput = v.InferOutput<typeof incorporateClaritySchema>

/** How a human resolves a clarity review that hit its iteration cap with findings open. */
export const resolveClarityExceededSchema = v.object({
  choice: iterationCapChoiceSchema,
})
export type ResolveClarityExceededInput = v.InferOutput<typeof resolveClarityExceededSchema>
export type ResolveClarityExceededChoice = ResolveClarityExceededInput['choice']
