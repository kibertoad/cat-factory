import { ref } from 'vue'
import type { Block } from '~/types/domain'

/**
 * Pointer-driven resizing for service frames (Miro-style border drag). The drag
 * delta is divided by the board zoom so the edge tracks the cursor, and the new
 * size is clamped to the frame's content extent so dragging in never clips the
 * tasks/modules inside. The frame grows live (the store block is mutated in place,
 * which `containerSize` reads back), and the final size is persisted once on
 * release rather than on every move.
 */
export function useFrameResize() {
  const board = useBoardStore()
  const ui = useUiStore()
  const access = useWorkspaceAccess()
  /** Id of the frame currently being resized, for cursor/handle styling. */
  const resizingId = ref<string | null>(null)

  /**
   * Begin a resize from one of the frame's edges/corner. `edge` selects which
   * dimensions move: `'e'` width only, `'s'` height only, `'se'` both.
   */
  function startResize(block: Block, e: PointerEvent, edge: 'e' | 's' | 'se') {
    if (e.button !== 0) return
    // Resizing a frame persists its size — a `board.write` mutation, so a read-only
    // viewer's resize no-ops (the grips are hidden for them at the component level).
    if (!access.canWriteBoard.value) return
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    // The content extent is the floor — never shrink a frame below its tasks.
    const min = board.contentSize(block.id)
    // Seed from the current rendered size so the first move doesn't jump.
    const start = board.containerSize(block.id)
    resizingId.value = block.id

    const onMove = (ev: PointerEvent) => {
      const z = ui.zoom || 1
      const w = edge === 's' ? start.w : Math.max(min.w, start.w + (ev.clientX - startX) / z)
      const h = edge === 'e' ? start.h : Math.max(min.h, start.h + (ev.clientY - startY) / z)
      // Optimistic, local-only: mutate the cached block so the frame grows live
      // without a round-trip on every pointer move.
      block.size = { w: Math.round(w), h: Math.round(h) }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      resizingId.value = null
      // Persist the final size once (also re-applies it as the authoritative block).
      if (block.size) void board.updateBlock(block.id, { size: block.size })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return { resizingId, startResize }
}
