// Requirements-review wire types. Mirror of `@cat-factory/contracts`'
// requirements.ts, kept in sync by hand like the rest of `~/types/*` (the SPA
// does not import the backend package directly).
//
// A stateless reviewer agent inspects a block's collected requirements and
// raises questions / gaps / clarifications; a human answers or dismisses each;
// then the agent folds the answers back into the block's requirements.
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  ReviewItemCategory,
  ReviewItemSeverity,
  ReviewItemStatus,
  RequirementReviewItem,
  RequirementReviewStatus,
  ResolveRequirementsExceededChoice,
  RecommendationStatus,
  RequirementRecommendation,
  RequirementReview,
  RequestRecommendationItem,
} from '@cat-factory/contracts'
