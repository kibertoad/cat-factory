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

export type RequirementReviewStatus = 'ready' | 'incorporated'

/**
 * A quality companion's verdict on one reworked requirements document — the shared
 * standardized shape stored by every companion site.
 */
export interface CompanionVerdict {
  /** Overall quality of the reworked requirements (0..1, higher = better). */
  rating: number
  /** The quality bar the rating had to reach to pass. */
  threshold: number
  /** Whether the rating met the threshold (the reworked doc was accepted). */
  passed: boolean
  /** The companion's challenge, shown to the human and fed into the next rework. */
  feedback: string
}

export interface RequirementReview {
  id: string
  blockId: string
  status: RequirementReviewStatus
  items: RequirementReviewItem[]
  model: string | null
  incorporatedRequirements: string | null
  /** One verdict per rework cycle, in order — the full correction sequence. Last is latest. */
  companionVerdicts: CompanionVerdict[]
  createdAt: number
  updatedAt: number
}
