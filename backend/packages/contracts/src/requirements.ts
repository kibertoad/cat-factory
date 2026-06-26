import * as v from 'valibot'
import { iterationCapChoiceSchema } from './iteration-cap.js'

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
 * off as not applicable, `recommend_requested` when the human asked the Requirement
 * Writer to suggest an answer instead of writing one. All of `answered`, `resolved`,
 * `dismissed` and `recommend_requested` count as "settled" (not `open`) for gating
 * incorporation — a finding awaiting a recommendation doesn't block the cycle, its
 * recommendation simply lands for review and folds into a later pass once accepted.
 */
export const reviewItemStatusSchema = v.picklist([
  'open',
  'answered',
  'resolved',
  'dismissed',
  'recommend_requested',
])
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
 * - `incorporating`: transient. The human answered the findings and asked to incorporate;
 *   the durable driver is folding the answers into a document (the FIRST async stage). No
 *   human action is needed — the user is back on the board.
 * - `reviewing`: transient. The document is folded and the reviewer is RE-reviewing it (the
 *   SECOND async stage). Distinguished from `incorporating` so the board/window can show
 *   which stage is running; the user is summoned again only if it yields `ready`/`exceeded`.
 * - `merged`: the companion produced an incorporated document (an internal transient on the
 *   async path — the driver re-reviews it immediately; only the off-path inline incorporate
 *   leaves a review here momentarily).
 * - `exceeded`: the iteration cap was reached with findings still open — awaiting the
 *   human's choice (one more round / proceed anyway / reset the task).
 * - `incorporated`: terminal. The requirements phase is settled; downstream agents
 *   consume {@link incorporatedRequirements} when present (else the original description).
 */
export const requirementReviewStatusSchema = v.picklist([
  'ready',
  'incorporating',
  'reviewing',
  'merged',
  'exceeded',
  'incorporated',
])
export type RequirementReviewStatus = v.InferOutput<typeof requirementReviewStatusSchema>

/**
 * Lifecycle of a single Requirement-Writer recommendation:
 * - `pending`: a placeholder created the moment the human requested the recommendation;
 *   the Writer is still producing the suggestion in the durable driver (the async story —
 *   the human is back on the board, summoned by a notification when the batch finishes).
 *   The placeholder snapshots its source finding so progress (`ready / total`) survives the
 *   window closing; `recommendedText` is empty until the Writer fills it in.
 * - `ready`: the Writer produced a suggested answer; the human hasn't decided yet.
 * - `accepted`: the human took the suggestion — it becomes the source finding's answer
 *   and folds into the NEXT incorporation pass.
 * - `rejected`: the human declined it (they then dismiss / answer manually / re-request).
 */
export const recommendationStatusSchema = v.picklist(['pending', 'ready', 'accepted', 'rejected'])
export type RecommendationStatus = v.InferOutput<typeof recommendationStatusSchema>

/**
 * A Requirement-Writer suggestion for one finding. Recommendations are a first-class
 * collection on the review (NOT on items) so they survive the item churn each re-review
 * causes — the source finding is snapshotted by title/detail rather than referenced by a
 * (volatile) item id. The Writer grounds the suggestion on the project's best-practice
 * fragments first, then `spec/` + `tech-spec/`, then web search; when the answer comes
 * straight from a best-practice fragment, {@link groundedInFragment} carries it so the UI
 * can mark the option as the current team/org standard. Recommendations are NOT AI-reviewed.
 */
export const requirementRecommendationSchema = v.object({
  id: v.string(),
  /**
   * Snapshot of the finding this recommends an answer for. `itemId` is the finding's id at
   * request time — the PRIMARY anchor, so two findings that happen to share an identical
   * title+detail stay distinct. Item ids churn across re-reviews, so matching falls back to
   * title+detail when the snapshotted id is no longer present (`itemId` is optional for that
   * reason and absent on pre-existing rows).
   */
  sourceFinding: v.object({
    title: v.string(),
    detail: v.string(),
    itemId: v.optional(v.string()),
  }),
  /** The suggested answer text. */
  recommendedText: v.string(),
  status: recommendationStatusSchema,
  /** A "do it differently" note the human attached when re-requesting, else null. */
  note: v.nullable(v.string()),
  /**
   * Set when the recommendation is taken directly from a best-practice fragment (the
   * "current standard" signal), else null. Carries the fragment's id + title for the badge.
   */
  groundedInFragment: v.nullable(v.object({ id: v.string(), title: v.string() })),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type RequirementRecommendation = v.InferOutput<typeof requirementRecommendationSchema>

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
  /**
   * Requirement-Writer suggestions awaiting (or settled by) human accept/reject. Survives
   * the re-review item churn — see {@link requirementRecommendationSchema}. Empty by default.
   */
  recommendations: v.optional(v.array(requirementRecommendationSchema), []),
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
 * Ask the Requirement Writer to recommend answers for a batch of findings (by item id).
 * Sent when the human marks findings "recommend something" instead of answering them. The
 * Writer runs ASYNCHRONOUSLY in the durable driver: the call returns at once with `pending`
 * placeholder recommendations, which fill in (`ready`) one by one and raise a notification
 * when the batch finishes. The optional `note` steers the whole batch ("prefer the existing
 * library", etc.).
 */
export const requestRecommendationsSchema = v.object({
  itemIds: v.pipe(v.array(v.string()), v.minLength(1)),
  note: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(4000))),
})
export type RequestRecommendationsInput = v.InferOutput<typeof requestRecommendationsSchema>

/**
 * Re-request a single recommendation with a "do it differently" note (the human rejected
 * the first suggestion but wants another grounded attempt rather than answering manually).
 */
export const reRequestRecommendationSchema = v.object({
  note: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4000)),
})
export type ReRequestRecommendationInput = v.InferOutput<typeof reRequestRecommendationSchema>

/**
 * How a human resolves a requirements review that hit its iteration cap with findings
 * still open: `extra-round` grants one more reviewer pass, `proceed` advances the
 * pipeline using the last incorporated document, `stop-reset` cancels the run and
 * returns the task to phase zero (editable) while keeping the last incorporated doc.
 * Shares the {@link iterationCapChoiceSchema} with the companion gate — same three
 * choices, one source of truth (see `./iteration-cap.ts`).
 */
export const resolveRequirementsExceededSchema = v.object({
  choice: iterationCapChoiceSchema,
})
export type ResolveRequirementsExceededInput = v.InferOutput<
  typeof resolveRequirementsExceededSchema
>
export type ResolveRequirementsExceededChoice = ResolveRequirementsExceededInput['choice']

// NOTE: the durable, in-repo PRESCRIPTIVE specification (the `spec.json` tree with its
// requirements, domain rules and acceptance criteria) lives in `./spec.ts`. This file
// is only the transient, per-block CONTEXT review of the linked-prose brief.
