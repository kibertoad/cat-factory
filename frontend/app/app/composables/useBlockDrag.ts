import { ref } from 'vue'
import { tryOnScopeDispose } from '@vueuse/core'
import type { Block } from '~/types/domain'

// Only one block is ever dragged at a time, so the dragged id is a module-level
// singleton: the component that starts the drag and a sibling that needs to react
// to it (e.g. BoardCanvas elevating the dragged service frame's z-index) read the
// same ref instead of separate per-call copies.
const draggingId = ref<string | null>(null)

/**
 * Pointer-driven dragging for blocks positioned inside a container's 2D canvas
 * (initiative cards inside services) and for free-floating service frames (via
 * their header handle). Movement is divided by the board zoom so the block tracks
 * the cursor. When `reparent` is set, the drop point is hit-tested against
 * `[data-drop-zone]` ancestors so a block can be dragged from a service into a
 * module (or back out).
 *
 * A TASK is a `positioned: false` drag, because tasks are laid out in swimlanes and
 * carry no coordinates a reader can see. Such a drag previews nothing and commits
 * nothing on a same-container drop: its ONLY effect is a reparent, which is what a
 * task drag is still for (moving work between services, and into or out of a module).
 * A position write there would persist coordinates nothing renders and emit a board
 * event for a change with no visible result.
 */
export function useBlockDrag() {
  const board = useBoardStore()
  const ui = useUiStore()
  const access = useWorkspaceAccess()

  /**
   * Tear down the in-flight drag's window listeners.
   *
   * They used to be removed inside `onUp` alone, which covers only the drag that ENDS. A touch
   * interruption (an incoming call, a system gesture) fires `pointercancel` and no `pointerup`,
   * and unmounting the dragging component fires neither, so both stranded a `pointermove` and a
   * `pointerup` on `window` plus a `draggingId` that never cleared, leaving the card dimmed and
   * every frame's z-index elevated for the rest of the session.
   */
  let endDrag: (() => void) | null = null
  tryOnScopeDispose(() => endDrag?.())

  function startDrag(
    block: Block,
    e: PointerEvent,
    opts: { reparent?: boolean; clamp?: boolean; positioned?: boolean } = {},
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
    // Container-local blocks (initiative cards) are clamped to their parent's origin;
    // frames live in free-floating flow space, so they opt out via `clamp: false`. Inert for
    // a `positioned: false` drag, which never writes a position at all.
    const clamp = opts.clamp ?? true
    const positioned = opts.positioned ?? true
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
      // A lane task has nowhere to preview TO: its place in the column is derived from its
      // status and the reader's sort, so following the cursor would be a lie the drop then
      // undoes. The `draggingId` state the card dims itself with is the whole feedback.
      if (positioned) board.previewMove(block.id, last)
    }
    // What is currently bound to `window`, so the teardown below needs no forward reference to
    // the handlers that call it.
    const bound: Array<[string, (ev: PointerEvent) => void]> = []
    /**
     * Stop listening and clear the drag state, WITHOUT committing anything. The shared exit for
     * every way a drag ends: the drop commits first and then calls this, and a cancel (a
     * `pointercancel`, or the component unmounting mid-drag) calls it alone.
     */
    const detach = () => {
      for (const [type, handler] of bound) {
        window.removeEventListener(type, handler as EventListener)
      }
      bound.length = 0
      endDrag = null
      draggingId.value = null
    }
    /**
     * A drag the pointer never finished. Nothing is persisted, so the local preview has to go
     * back where it started: leaving it would show a position the server does not hold and the
     * next refresh would silently snap the block back.
     */
    const onCancel = () => {
      if (moved && positioned) board.previewMove(block.id, orig)
      detach()
    }
    const onUp = (ev: PointerEvent) => {
      if (moved) {
        // A successful reparent persists the move itself; otherwise commit the final
        // position in place. Either way it's a single write, not one per frame. Run
        // the hit-test BEFORE clearing draggingId so the dragged element is still
        // marked non-interactive (see LaneTask) and the zone beneath resolves.
        const reparented = opts.reparent && reparentAt(block, ev.clientX, ev.clientY, positioned)
        if (!reparented && positioned) void board.moveBlock(block.id, last)
      }
      detach()
    }
    // A second drag can only start after the first released or cancelled, but a stale listener
    // set would silently drive it; end whatever is still attached before attaching this one.
    endDrag?.()
    endDrag = onCancel
    for (const binding of [
      ['pointermove', onMove],
      ['pointerup', onUp],
      ['pointercancel', onCancel],
    ] as Array<[string, (ev: PointerEvent) => void]>) {
      bound.push(binding)
      window.addEventListener(binding[0], binding[1] as EventListener)
    }
  }

  /** Returns true when the block was dropped into a *different* container. */
  function reparentAt(
    block: Block,
    clientX: number,
    clientY: number,
    positioned: boolean,
  ): boolean {
    const el = document.querySelector(`[data-block-id="${block.id}"]`) as HTMLElement | null
    if (!el) return false
    // The dragged block is already non-interactive while dragging (LaneTask
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

    void board.reparentBlock(block.id, newParent, positionIn(zoneEl, el, positioned))
    return true
  }

  /**
   * Where the dropped block lands in its new container.
   *
   * A lane task gets the origin, not the coordinates it happened to be released over.
   * Its place in the new container is derived from its status and the reader's sort, so a
   * captured offset would be a coordinate nothing reads and every later reader would have
   * to wonder whether it meant something.
   */
  function positionIn(zoneEl: HTMLElement, el: HTMLElement, positioned: boolean) {
    if (!positioned) return { x: 0, y: 0 }
    const z = ui.zoom || 1
    const zr = zoneEl.getBoundingClientRect()
    const er = el.getBoundingClientRect()
    return {
      x: Math.max(0, (er.left - zr.left) / z),
      y: Math.max(0, (er.top - zr.top) / z),
    }
  }

  return { draggingId, startDrag }
}
