import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Requirements-review wire contracts. A reviewer agent inspects a board block's
// "collected requirements" — its description plus any linked PRD / RFC /
// requirements documents and tracker issues — and raises a list of review items:
// gaps, ambiguities, unstated assumptions, risks and open questions, each with a
// severity. A human answers or dismisses each item; an incorporation companion
// folds the answers into one standardized requirements document, then the reviewer
// re-reviews that document. The cycle repeats until the reviewer is clean (or every
// remaining finding is dismissed / tolerated by the task's severity threshold), or
// the task's iteration cap is hit and a human picks how to proceed.
//
// On the pipeline path the run parks on the requirements step while the human drives
// these round-trips; the run only advances (converge / proceed) or resets exactly
// once. The review + its items are persisted and mutated in plain request/response
// round-trips. Storage-only bookkeeping (the owning workspace) is NOT on the wire.
// ---------------------------------------------------------------------------

/** What kind of concern a review item raises. */
export const reviewItemCategorySchema = v.picklist([
  'gap',
  'clarification',
  'assumption',
  'risk',
  'question',
])
export type ReviewItemCategory = v.InferOutput<typeof reviewItemCategorySchema>

/** How important resolving the item is before implementation should proceed. */
export const reviewItemSeveritySchema = v.picklist(['low', 'medium', 'high'])
export type ReviewItemSeverity = v.InferOutput<typeof reviewItemSeveritySchema>

/**
 * Lifecycle of a single item: `open` until a human engages, `answered` once a
 * reply is recorded, `resolved` when accepted as done, `dismissed` when waved
 * off as not applicable. Both `resolved` and `dismissed` count as "settled" for
 * the purpose of gating incorporation.
 */
export const reviewItemStatusSchema = v.picklist(['open', 'answered', 'resolved', 'dismissed'])
export type ReviewItemStatus = v.InferOutput<typeof reviewItemStatusSchema>

/** A single question / challenge the reviewer raised about the requirements. */
export const requirementReviewItemSchema = v.object({
  id: v.string(),
  category: reviewItemCategorySchema,
  severity: reviewItemSeveritySchema,
  /** Short headline of the concern. */
  title: v.string(),
  /** The full question / gap / challenge, in plain prose. */
  detail: v.string(),
  status: reviewItemStatusSchema,
  /** The human's answer, or null while unanswered. */
  reply: v.nullable(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type RequirementReviewItem = v.InferOutput<typeof requirementReviewItemSchema>

/**
 * Lifecycle of the review as a whole:
 * - `ready`: the reviewer raised findings that are awaiting human answers/dismissals.
 * - `merged`: the companion produced an incorporated document the human is inspecting
 *   (they can re-review it, or redo the merge with a comment).
 * - `exceeded`: the iteration cap was reached with findings still open — awaiting the
 *   human's choice (one more round / proceed anyway / reset the task).
 * - `incorporated`: terminal. The requirements phase is settled; downstream agents
 *   consume {@link incorporatedRequirements} when present (else the original description).
 */
export const requirementReviewStatusSchema = v.picklist([
  'ready',
  'merged',
  'exceeded',
  'incorporated',
])
export type RequirementReviewStatus = v.InferOutput<typeof requirementReviewStatusSchema>

/** A completed requirements review for one board block. */
export const requirementReviewSchema = v.object({
  id: v.string(),
  blockId: v.string(),
  status: requirementReviewStatusSchema,
  items: v.array(requirementReviewItemSchema),
  /** `provider:model` that produced the review, for transparency; null in tests. */
  model: v.nullable(v.string()),
  /**
   * The revised requirements text the incorporation companion last folded the answers
   * into. Set once a doc has been produced (status `merged`/`incorporated`); null while
   * still awaiting answers on the first pass. Consumed by every downstream agent step +
   * the spec-writer once the phase is settled.
   */
  incorporatedRequirements: v.nullable(v.string()),
  /**
   * How many reviewer passes have run so far (the initial review is iteration 1; each
   * re-review adds one). Compared against {@link maxIterations} to decide when the loop
   * has exhausted its budget.
   */
  iteration: v.optional(v.number(), 1),
  /**
   * The reviewer-pass budget for this review, snapshotted from the task's merge preset
   * (`maxRequirementIterations`) when the review started. An "extra round" choice bumps
   * it by one.
   */
  maxIterations: v.optional(v.number(), 1),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type RequirementReview = v.InferOutput<typeof requirementReviewSchema>

// ---- Request bodies -------------------------------------------------------

/** Record a human's answer to a single review item. */
export const replyReviewItemSchema = v.object({
  reply: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4000)),
})
export type ReplyReviewItemInput = v.InferOutput<typeof replyReviewItemSchema>

/** Set a review item's status (resolve / dismiss / reopen). */
export const updateReviewItemStatusSchema = v.object({
  status: reviewItemStatusSchema,
})
export type UpdateReviewItemStatusInput = v.InferOutput<typeof updateReviewItemStatusSchema>

/**
 * Incorporate the settled answers into a standardized requirements document. An optional
 * `feedback` comment is the human's "do it differently" lever when redoing a merge they
 * were unhappy with — it is folded into the rework prompt alongside the prior document.
 */
export const incorporateRequirementsSchema = v.object({
  feedback: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(4000))),
})
export type IncorporateRequirementsInput = v.InferOutput<typeof incorporateRequirementsSchema>

/**
 * How a human resolves a requirements review that hit its iteration cap with findings
 * still open: `extra-round` grants one more reviewer pass, `proceed` advances the
 * pipeline using the last incorporated document, `stop-reset` cancels the run and
 * returns the task to phase zero (editable) while keeping the last incorporated doc.
 */
export const resolveRequirementsExceededSchema = v.object({
  choice: v.picklist(['extra-round', 'proceed', 'stop-reset']),
})
export type ResolveRequirementsExceededInput = v.InferOutput<
  typeof resolveRequirementsExceededSchema
>
export type ResolveRequirementsExceededChoice = ResolveRequirementsExceededInput['choice']

// NOTE: the durable, in-repo PRESCRIPTIVE specification (the `spec.json` tree with its
// requirements, domain rules and acceptance criteria) lives in `./spec.ts`. This file
// is only the transient, per-block CONTEXT review of the linked-prose brief.
