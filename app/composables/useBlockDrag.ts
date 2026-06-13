import { ref } from 'vue'
import type { Block } from '~/types/domain'

/**
 * Pointer-driven dragging for blocks positioned inside a container's 2D canvas
 * (tasks inside services/modules, modules inside services). Movement is divided
 * by the board zoom so the block tracks the cursor. When `reparent` is set, the
 * drop point is hit-tested against `[data-drop-zone]` ancestors so a task can be
 * dragged from a service into a module (or back out).
 */
export function useBlockDrag() {
  const board = useBoardStore()
  const ui = useUiStore()
  const draggingId = ref<string | null>(null)

  function startDrag(
    block: Block,
    e: PointerEvent,
    opts: { reparent?: boolean; clamp?: boolean } = {},
  ) {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    const orig = { ...block.position }
    // Container-local blocks (tasks/modules) are clamped to their parent's origin;
    // frames live in free-floating flow space, so they opt out via `clamp: false`.
    const clamp = opts.clamp ?? true
    draggingId.value = block.id

    const onMove = (ev: PointerEvent) => {
      const z = ui.zoom || 1
      const nx = orig.x + (ev.clientX - startX) / z
      const ny = orig.y + (ev.clientY - startY) / z
      board.moveBlock(block.id, {
        x: clamp ? Math.max(0, nx) : nx,
        y: clamp ? Math.max(0, ny) : ny,
      })
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (opts.reparent) reparentAt(block, ev.clientX, ev.clientY)
      draggingId.value = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function reparentAt(block: Block, clientX: number, clientY: number) {
    const el = document.querySelector(`[data-block-id="${block.id}"]`) as HTMLElement | null
    if (!el) return
    // hide the dragged element so elementFromPoint sees the zone beneath it
    const prev = el.style.pointerEvents
    el.style.pointerEvents = 'none'
    const under = document.elementFromPoint(clientX, clientY) as HTMLElement | null
    const zoneEl = under?.closest('[data-drop-zone]') as HTMLElement | null
    el.style.pointerEvents = prev
    if (!zoneEl) return

    const newParent = zoneEl.getAttribute('data-drop-zone')!
    if (newParent === block.parentId) return // same container — keep the new position

    const z = ui.zoom || 1
    const zr = zoneEl.getBoundingClientRect()
    const er = el.getBoundingClientRect()
    board.reparentBlock(block.id, newParent, {
      x: Math.max(0, (er.left - zr.left) / z),
      y: Math.max(0, (er.top - zr.top) / z),
    })
  }

  return { draggingId, startDrag }
}
