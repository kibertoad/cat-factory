// Clarity-review wire types. Mirror of `@cat-factory/contracts`' clarity.ts, kept
// in sync by hand like the rest of `~/types/*` (the SPA does not import the backend
// package directly).
//
// A stateless reviewer agent triages a block's BUG REPORT for fixability — raising
// questions / gaps / clarifications about the report; a human answers or dismisses
// each; then the agent folds the answers back into a clarified bug report.
//
// Structurally identical to a requirements review (the items share the same shape),
// so the per-item types are reused from `~/types/requirements`; only the
// incorporated document differs (`clarifiedReport`).
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  ClarityReviewItem,
  ClarityReviewStatus,
  ResolveClarityExceededChoice,
  ClarityReview,
  // The per-item types are shared with a requirements review (same shape).
  ReviewItemCategory,
  ReviewItemSeverity,
  ReviewItemStatus,
} from '@cat-factory/contracts'
