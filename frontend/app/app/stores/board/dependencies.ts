import { useWorkspaceStore } from '~/stores/workspace'
import type { BoardWriteContext } from './context'

/**
 * The board's dependency-edge writes. Split out of {@link createBoardPlacement} along the same
 * seam it was split from {@link createBoardMutations}: it closes over the shared
 * {@link BoardWriteContext} so behaviour is identical to the original in-closure functions, and
 * the split is purely to keep every function within the size budget.
 */
export function createBoardDependencies(ctx: BoardWriteContext) {
  const { getBlock, upsert, api, present } = ctx

  /**
   * Toggle a dependency edge target -> source (target dependsOn source). The backend
   * rejects an edge that would close a cycle (422) — surface that as a toast rather than
   * letting it throw unhandled out of a board gesture.
   */
  async function toggleDependency(targetId: string, sourceId: string) {
    if (targetId === sourceId || !getBlock(targetId)) return
    try {
      upsert(await api.toggleDependency(useWorkspaceStore().requireId(), targetId, { sourceId }))
    } catch (e) {
      present(e, 'board.toast.linkFailed')
    }
  }

  /** Remove a dependency edge target -> source if it exists. */
  async function removeDependency(targetId: string, sourceId: string) {
    const t = getBlock(targetId)
    if (!t || !t.dependsOn.includes(sourceId)) return
    // the backend exposes a single toggle; the edge exists, so toggling removes it
    try {
      upsert(await api.toggleDependency(useWorkspaceStore().requireId(), targetId, { sourceId }))
    } catch (e) {
      // Mirror `toggleDependency`: a failure must surface (and leave the edge visible) rather
      // than rejecting unhandled with no feedback.
      present(e, 'board.toast.unlinkFailed')
    }
  }

  return { toggleDependency, removeDependency }
}
