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
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  BrainstormStage,
  BrainstormItem,
  BrainstormStatus,
  ResolveBrainstormExceededChoice,
  BrainstormSession,
  // The per-item types are shared with a requirements review (same shape).
  ReviewItemCategory,
  ReviewItemSeverity,
  ReviewItemStatus,
} from '@cat-factory/contracts'
import type { UpdateBrainstormItemStatusInput } from '@cat-factory/contracts'

/** The narrower status set the set-item-status action accepts (a subset of ReviewItemStatus). */
export type BrainstormItemStatus = UpdateBrainstormItemStatusInput['status']
