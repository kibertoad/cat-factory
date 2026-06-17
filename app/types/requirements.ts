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

export interface RequirementReview {
  id: string
  blockId: string
  status: RequirementReviewStatus
  items: RequirementReviewItem[]
  model: string | null
  incorporatedRequirements: string | null
  createdAt: number
  updatedAt: number
}
