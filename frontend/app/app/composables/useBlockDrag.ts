import { ref } from 'vue'
import type { Block } from '~/types/domain'

// Only one block is ever dragged at a time, so the dragged id is a module-level
// singleton: the component that starts the drag and a sibling that needs to react
// to it (e.g. BoardCanvas elevating the dragged service frame's z-index) read the
// same ref instead of separate per-call copies.
const draggingId = ref<string | null>(null)

/**
 * Pointer-driven dragging for blocks positioned inside a container's 2D canvas
 * (tasks inside services/modules, modules inside services) and for free-floating
 * service frames (via their header handle). Movement is divided by the board zoom
 * so the block tracks the cursor. When `reparent` is set, the drop point is
 * hit-tested against `[data-drop-zone]` ancestors so a task can be dragged from a
 * service into a module (or back out).
 */
export function useBlockDrag() {
  const board = useBoardStore()
  const ui = useUiStore()
  const access = useWorkspaceAccess()

  function startDrag(
    block: Block,
    e: PointerEvent,
    opts: { reparent?: boolean; clamp?: boolean } = {},
  ) {
    if (e.button !== 0) return
    // Read-only viewers can pan/inspect but never move or reparent a block — the drag
    // is a `board.write` mutation, so it no-ops for them (the SPA mirror of the backend
    // member floor; the affordance itself is hidden/disabled at the button level too).
    if (!access.canWriteBoard.value) return
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    const orig = { ...block.position }
    // Container-local blocks (tasks/modules) are clamped to their parent's origin;
    // frames live in free-floating flow space, so they opt out via `clamp: false`.
    const clamp = opts.clamp ?? true
    draggingId.value = block.id
    // Position is only previewed locally while dragging and persisted once on
    // release. Writing every move raced — a late, out-of-order response could land
    // a stale position last and make the block jump after the user let go.
    let moved = false
    let last = orig

    const onMove = (ev: PointerEvent) => {
      const z = ui.zoom || 1
      const nx = orig.x + (ev.clientX - startX) / z
      const ny = orig.y + (ev.clientY - startY) / z
      moved = true
      last = { x: clamp ? Math.max(0, nx) : nx, y: clamp ? Math.max(0, ny) : ny }
      board.previewMove(block.id, last)
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (moved) {
        // A successful reparent persists the move itself; otherwise commit the final
        // position in place. Either way it's a single write, not one per frame. Run
        // the hit-test BEFORE clearing draggingId so the dragged element is still
        // marked non-interactive (see DraggableTask) and the zone beneath resolves.
        const reparented = opts.reparent && reparentAt(block, ev.clientX, ev.clientY)
        if (!reparented) void board.moveBlock(block.id, last)
      }
      draggingId.value = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  /** Returns true when the block was dropped into a *different* container. */
  function reparentAt(block: Block, clientX: number, clientY: number): boolean {
    const el = document.querySelector(`[data-block-id="${block.id}"]`) as HTMLElement | null
    if (!el) return false
    // The dragged block is already non-interactive while dragging (DraggableTask
    // drops pointer-events on the whole wrapper, handle included); belt-and-braces,
    // also neutralise this node so elementFromPoint resolves the zone beneath it.
    const prev = el.style.pointerEvents
    el.style.pointerEvents = 'none'
    const under = document.elementFromPoint(clientX, clientY) as HTMLElement | null
    const zoneEl = under?.closest('[data-drop-zone]') as HTMLElement | null
    el.style.pointerEvents = prev
    if (!zoneEl) return false

    const newParent = zoneEl.getAttribute('data-drop-zone')!
    if (newParent === block.parentId) return false // same container — caller commits position

    const z = ui.zoom || 1
    const zr = zoneEl.getBoundingClientRect()
    const er = el.getBoundingClientRect()
    void board.reparentBlock(block.id, newParent, {
      x: Math.max(0, (er.left - zr.left) / z),
      y: Math.max(0, (er.top - zr.top) / z),
    })
    return true
  }

  return { draggingId, startDrag }
}
