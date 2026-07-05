// ---------------------------------------------------------------------------
// Document-source integration. Requirements / RFCs / PRDs imported from external
// sources (Confluence, Notion, …) can be expanded into board structure or
// attached to a task as agent context.
//
// All wire shapes are sourced from @cat-factory/contracts (single source of
// truth). `SpawnResult` has no exported contract type (the contract models it
// inline), so it stays frontend-only below.
// ---------------------------------------------------------------------------

export type {
  DocumentSourceKind,
  DocumentLinkRole,
  CredentialField,
  DocumentSourceDescriptor,
  DocumentConnection,
  SourceDocument,
  DocumentSearchResult,
  PlanTask,
  PlanModule,
  PlanFrame,
  DocumentBoardPlan,
} from '@cat-factory/contracts'

/** Counts of blocks created by spawning a plan onto the board. Frontend-only. */
export interface SpawnResult {
  frames: number
  modules: number
  tasks: number
}
