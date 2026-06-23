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

import type {
  RequirementReviewItem,
  ReviewItemCategory,
  ReviewItemSeverity,
  ReviewItemStatus,
} from '~/types/requirements'

export type { ReviewItemCategory, ReviewItemSeverity, ReviewItemStatus }

/** A clarity-review item is the same shape as a requirements-review item. */
export type ClarityReviewItem = RequirementReviewItem

/**
 * - `ready`: the reviewer raised findings awaiting human answers/dismissals.
 * - `incorporating`: transient; the driver is folding the answers into a document (the FIRST
 *   async stage — the user is back on the board).
 * - `reviewing`: transient; the reviewer is RE-reviewing the folded document (the SECOND
 *   async stage). Distinct from `incorporating` so the UI can show which stage is running.
 * - `merged`: the companion produced a document (an internal transient on the async path).
 * - `exceeded`: the iteration cap was hit with findings open — awaiting the human's choice.
 * - `incorporated`: terminal; the clarity phase is settled.
 */
export type ClarityReviewStatus =
  | 'ready'
  | 'incorporating'
  | 'reviewing'
  | 'merged'
  | 'exceeded'
  | 'incorporated'

/** How a human resolves a review that hit its iteration cap. */
export type ResolveClarityExceededChoice = 'extra-round' | 'proceed' | 'stop-reset'

export interface ClarityReview {
  id: string
  blockId: string
  status: ClarityReviewStatus
  items: ClarityReviewItem[]
  model: string | null
  clarifiedReport: string | null
  /** Reviewer passes run so far (initial review is 1; each re-review adds one). */
  iteration: number
  /** The reviewer-pass budget (from the task's merge preset; an extra round bumps it). */
  maxIterations: number
  createdAt: number
  updatedAt: number
}
