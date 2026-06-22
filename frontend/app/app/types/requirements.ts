// Requirements-review wire types. Mirror of `@cat-factory/contracts`'
// requirements.ts, kept in sync by hand like the rest of `~/types/*` (the SPA
// does not import the backend package directly).
//
// A stateless reviewer agent inspects a block's collected requirements and
// raises questions / gaps / clarifications; a human answers or dismisses each;
// then the agent folds the answers back into the block's requirements.

export type ReviewItemCategory = 'gap' | 'clarification' | 'assumption' | 'risk' | 'question'

export type ReviewItemSeverity = 'low' | 'medium' | 'high'

export type ReviewItemStatus = 'open' | 'answered' | 'resolved' | 'dismissed'

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
 * - `merged`: the companion produced a document the human is inspecting (re-review or redo).
 * - `exceeded`: the iteration cap was hit with findings open — awaiting the human's choice.
 * - `incorporated`: terminal; the requirements phase is settled.
 */
export type RequirementReviewStatus = 'ready' | 'merged' | 'exceeded' | 'incorporated'

/** How a human resolves a review that hit its iteration cap. */
export type ResolveRequirementsExceededChoice = 'extra-round' | 'proceed' | 'stop-reset'

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
  createdAt: number
  updatedAt: number
}
