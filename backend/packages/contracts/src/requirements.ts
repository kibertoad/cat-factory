import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Requirements-review wire contracts. A stateless reviewer agent inspects a
// board block's "collected requirements" — its description plus any linked
// PRD / RFC / requirements documents and tracker issues — and raises a list of
// review items: gaps, ambiguities, unstated assumptions, risks and open
// questions. A human answers or dismisses each item; once every item is settled
// the agent folds the answers back into the block's requirements (the
// "incorporate" step).
//
// Unlike the execution / bootstrap flows this is fully synchronous and
// stateless — there is no container and no durable driver — so the review and
// its items are persisted (migration 0021) but mutated in plain request/response
// round-trips. Storage-only bookkeeping (the owning workspace) is NOT on the
// wire; it lives in the core ports / D1 layer.
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
 * Lifecycle of the review as a whole: `ready` once items are generated and
 * awaiting human answers, `incorporated` once the answers have been folded back
 * into the block's requirements.
 */
export const requirementReviewStatusSchema = v.picklist(['ready', 'incorporated'])
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
   * The revised requirements text the reviewer last folded the answers into (the
   * new block description). Null until an incorporate run has completed.
   */
  incorporatedRequirements: v.nullable(v.string()),
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

// NOTE: the durable, in-repo PRESCRIPTIVE specification (the `spec.json` tree with its
// requirements, domain rules and acceptance criteria) lives in `./spec.ts`. This file
// is only the transient, per-block CONTEXT review of the linked-prose brief.
