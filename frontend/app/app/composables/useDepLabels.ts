import type { Block } from '~/types/domain'

/**
 * Labels a dependency block, qualifying it with its owning frame when it lives
 * in a different container than the task depending on it (a "cross-frame" edge).
 * Shared by the inspector and the task card so the two read identically.
 */
export function useDepLabels() {
  const board = useBoardStore()

  /** Title of a block's parent container, if any. */
  function frameTitle(b: Block): string | undefined {
    return b.parentId ? board.getBlock(b.parentId)?.title : undefined
  }

  /**
   * `Parent / Title` when `dep` lives in a different container than
   * `contextParentId`, otherwise just the dependency's own title.
   */
  function depLabel(dep: Block, contextParentId?: string | null): string {
    const f = frameTitle(dep)
    return f && dep.parentId !== contextParentId ? `${f} / ${dep.title}` : dep.title
  }

  return { frameTitle, depLabel }
}
