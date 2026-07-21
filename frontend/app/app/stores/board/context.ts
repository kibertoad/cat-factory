import type { Ref } from 'vue'
import type { Block } from '~/types/domain'

/** A detached subtree captured before an optimistic delete, restored on failure. */
export interface RemovalSnapshot {
  /** The removed block + all its descendants, in their original order. */
  removed: Block[]
  /**
   * Survivors whose `dependsOn`/`epicId`/`initiativeId` lost an edge to a removed block
   * (originals to restore on rollback).
   */
  edges: { id: string; dependsOn: string[]; epicId: string | null; initiativeId: string | null }[]
}

/** A still-pending optimistic delete: its snapshot, the deferred-commit timer, and its workspace. */
export interface PendingRemoval {
  snap: RemovalSnapshot
  timer: ReturnType<typeof setTimeout>
  wsId: string
}

/**
 * How long a deleted block stays undoable. The backend delete is DEFERRED for this
 * window (a real "undo", not a client illusion) — the block is hidden immediately but
 * only actually deleted once the window elapses, so undo just cancels the pending call.
 */
export const UNDO_WINDOW_MS = 6000

/**
 * Shared state + injected dependencies the board-store write factories close over. Created once in
 * the `board` store setup and threaded into {@link createBoardMutations} / {@link createBoardRemoval}
 * so the split operations stay behaviourally identical to the original single-closure store — the
 * factories are cohesive extractions purely to keep each function within the size budget, not new
 * seams. `api`/`toast`/`tr` are the store's own resolved handles (a store runs outside a component
 * `setup`, so `tr` bridges to the Nuxt app's global i18n instance).
 */
export interface BoardWriteContext {
  blocks: Ref<Block[]>
  getBlock: (id: string) => Block | undefined
  upsert: (block: Block) => void
  pendingRemovals: Map<string, PendingRemoval>
  pendingDoomed: Set<string>
  api: ReturnType<typeof useApi>
  toast: ReturnType<typeof useToast>
  tr: (key: string, params?: Record<string, unknown>) => string
}
