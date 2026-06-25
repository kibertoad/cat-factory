// Requirements-review wire types. Mirror of `@cat-factory/contracts`'
// requirements.ts, kept in sync by hand like the rest of `~/types/*` (the SPA
// does not import the backend package directly).
//
// A stateless reviewer agent inspects a block's collected requirements and
// raises questions / gaps / clarifications; a human answers or dismisses each;
// then the agent folds the answers back into the block's requirements.

export type ReviewItemCategory = 'gap' | 'clarification' | 'assumption' | 'risk' | 'question'

export type ReviewItemSeverity = 'low' | 'medium' | 'high'

export type ReviewItemStatus =
  | 'open'
  | 'answered'
  | 'resolved'
  | 'dismissed'
  | 'recommend_requested'

export interface RequirementReviewItem {
  id: string
  category: ReviewItemCategory
  severity: ReviewItemSeverity
  title: string
  detail: string
  status: ReviewItemStatus
  reply: string | null
  createdAt: number
  updatedAt: number
}

/**
 * - `ready`: the reviewer raised findings awaiting human answers/dismissals.
 * - `incorporating`: transient; the driver is folding the answers into a document (the FIRST
 *   async stage — the user is back on the board).
 * - `reviewing`: transient; the reviewer is RE-reviewing the folded document (the SECOND
 *   async stage). Distinct from `incorporating` so the UI can show which stage is running.
 * - `merged`: the companion produced a document (an internal transient on the async path).
 * - `exceeded`: the iteration cap was hit with findings open — awaiting the human's choice.
 * - `incorporated`: terminal; the requirements phase is settled.
 */
export type RequirementReviewStatus =
  | 'ready'
  | 'incorporating'
  | 'reviewing'
  | 'merged'
  | 'exceeded'
  | 'incorporated'

/** How a human resolves a review that hit its iteration cap. */
export type ResolveRequirementsExceededChoice = 'extra-round' | 'proceed' | 'stop-reset'

/**
 * Lifecycle of a Requirement-Writer recommendation. `pending` is a placeholder created the
 * moment the human requests it — the Writer is still producing the suggestion in the background
 * (the async story); it fills in to `ready` via the `requirements` stream.
 */
export type RecommendationStatus = 'pending' | 'ready' | 'accepted' | 'rejected'

/**
 * A Requirement-Writer suggestion for one finding. First-class on the review (survives the
 * re-review item churn); the source finding is snapshotted by title/detail. `groundedInFragment`
 * marks a suggestion taken straight from a best-practice fragment (the "current standard").
 */
export interface RequirementRecommendation {
  id: string
  sourceFinding: { title: string; detail: string }
  recommendedText: string
  status: RecommendationStatus
  note: string | null
  groundedInFragment: { id: string; title: string } | null
  createdAt: number
  updatedAt: number
}

export interface RequirementReview {
  id: string
  blockId: string
  status: RequirementReviewStatus
  items: RequirementReviewItem[]
  model: string | null
  incorporatedRequirements: string | null
  /** Reviewer passes run so far (initial review is 1; each re-review adds one). */
  iteration: number
  /** The reviewer-pass budget (from the task's merge preset; an extra round bumps it). */
  maxIterations: number
  /** Requirement-Writer suggestions awaiting (or settled by) human accept/reject. */
  recommendations: RequirementRecommendation[]
  createdAt: number
  updatedAt: number
}
