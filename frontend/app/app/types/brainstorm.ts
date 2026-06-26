// Brainstorm (structured-dialogue) wire types. Mirror of `@cat-factory/contracts`'
// brainstorm.ts, kept in sync by hand like the rest of `~/types/*` (the SPA does not import
// the backend package directly).
//
// A brainstorm agent runs a structured dialogue: it PROPOSES options with explicit
// trade-offs (raised as review items), a human picks / steers / dismisses, and the picks are
// folded into ONE converged direction. There are two stages (`requirements`, `architecture`)
// served by one engine; a block may have one live session per stage.
//
// Structurally identical to a requirements review (the items share the same shape), so the
// per-item types are reused from `~/types/requirements`; only the `stage` discriminator and
// the converged document (`convergedDirection`) differ.

import type {
  RequirementReviewItem,
  ReviewItemCategory,
  ReviewItemSeverity,
  ReviewItemStatus,
} from '~/types/requirements'

export type { ReviewItemCategory, ReviewItemSeverity, ReviewItemStatus }

/** Which dialogue a brainstorm session drives. */
export type BrainstormStage = 'requirements' | 'architecture'

/** A brainstorm option is the same shape as a requirements-review item. */
export type BrainstormItem = RequirementReviewItem

/** Lifecycle of a brainstorm session — identical to the requirements review lifecycle. */
export type BrainstormStatus =
  | 'ready'
  | 'incorporating'
  | 'reviewing'
  | 'merged'
  | 'exceeded'
  | 'incorporated'

/** How a human resolves a session that hit its iteration cap. */
export type ResolveBrainstormExceededChoice = 'extra-round' | 'proceed' | 'stop-reset'

export interface BrainstormSession {
  id: string
  blockId: string
  stage: BrainstormStage
  status: BrainstormStatus
  items: BrainstormItem[]
  model: string | null
  convergedDirection: string | null
  /** Agent passes run so far (initial pass is 1; each re-run adds one). */
  iteration: number
  /** The agent-pass budget (from the task's merge preset; an extra round bumps it). */
  maxIterations: number
  createdAt: number
  updatedAt: number
}
