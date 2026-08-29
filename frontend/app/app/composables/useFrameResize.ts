import { ref } from 'vue'
import type { Block } from '~/types/domain'

/**
 * The eight border/corner grips, each as the pair of unit factors saying how far the drag moves
 * the container's ORIGIN versus its far edge. `1` on an origin axis means that axis's border is
 * the one being dragged (west/north), so the box grows the OPPOSITE way from the pointer delta.
 *
 * Encoding the geometry as data rather than a `switch` per axis is what keeps the corners honest:
 * `nw` is exactly `n` and `w` applied together, and there is no eighth case to forget.
 */
const HANDLES = {
  n: { ox: 0, oy: 1, sx: 0, sy: -1, cursor: 'ns-resize' },
  s: { ox: 0, oy: 0, sx: 0, sy: 1, cursor: 'ns-resize' },
  e: { ox: 0, oy: 0, sx: 1, sy: 0, cursor: 'ew-resize' },
  w: { ox: 1, oy: 0, sx: -1, sy: 0, cursor: 'ew-resize' },
  ne: { ox: 0, oy: 1, sx: 1, sy: -1, cursor: 'nesw-resize' },
  nw: { ox: 1, oy: 1, sx: -1, sy: -1, cursor: 'nwse-resize' },
  se: { ox: 0, oy: 0, sx: 1, sy: 1, cursor: 'nwse-resize' },
  sw: { ox: 1, oy: 0, sx: -1, sy: 1, cursor: 'nesw-resize' },
} as const

export type ResizeEdge = keyof typeof HANDLES

/**
 * Id of the container currently being resized, for cursor/grip styling and for the board's
 * overlap guard, which stands down while a border is still under the pointer and settles the
 * board around this container once it is released.
 *
 * Module-level for the same reason as `useBlockDrag`'s `draggingId`: only one container is ever
 * resized at a time, and the grips that start the drag are not the only reader.
 */
const resizingId = ref<string | null>(null)

/** The grips in render order, so a component can `v-for` them instead of listing eight blocks. */
export const RESIZE_EDGES = Object.keys(HANDLES) as ResizeEdge[]

/** The `cursor` a given grip shows, and holds on `<body>` while its drag runs. */
export function resizeCursor(edge: ResizeEdge): string {
  return HANDLES[edge].cursor
}

/**
 * Pointer-driven resizing for containers (service frames and modules) by dragging any border or
 * corner, Miro-style. The drag delta is divided by the board zoom so the border tracks the
 * cursor, and the new size is clamped to the container's content extent so dragging inwards never
 * clips the tasks/modules inside.
 *
 * Dragging the north or west border also moves the container's ORIGIN, and a child's position is
 * stored relative to that origin — so the store translates the children by the inverse (see
 * `previewResize`) and the backend does the same on commit, which is what makes the border extend
 * past the contents instead of dragging them along. The origin is derived from the CLAMPED size
 * rather than from the raw pointer delta: once the box has hit its content floor the border must
 * stop dead, and a separately-clamped origin would keep sliding, walking the whole container
 * across the board.
 *
 * The container grows live off the store's optimistic geometry, and the final bounds are
 * persisted ONCE on release rather than on every move.
 */
export function useFrameResize() {
  const board = useBoardStore()
  const ui = useUiStore()
  const access = useWorkspaceAccess()

  /**
   * How far the origin may travel INWARD before the nearest child would land at a negative
   * offset — i.e. outside the box, spilling over the very border being dragged. `contentSize` is
   * no help here: it measures only the FAR edge of the contents, which a north/west shrink moves
   * inward in step with the border, so nothing there ever objects. `Infinity` for an empty
   * container, which is then bounded by `contentSize`'s empty floor alone.
   */
  function originSlack(id: string): { x: number; y: number } {
    const children = board.childrenOf(id)
    if (!children.length) return { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY }
    return {
      x: Math.min(...children.map((c) => c.position.x)),
      y: Math.min(...children.map((c) => c.position.y)),
    }
  }

  /** Begin a resize from one of the container's borders or corners. */
  function startResize(block: Block, e: PointerEvent, edge: ResizeEdge) {
    if (e.button !== 0) return
    // Resizing persists geometry — a `board.write` mutation, so a read-only viewer's resize
    // no-ops (the grips are hidden for them at the component level).
    if (!access.canWriteBoard.value) return
    e.preventDefault()
    e.stopPropagation()
    const handle = HANDLES[edge]
    const startX = e.clientX
    const startY = e.clientY
    // Seed from the current rendered geometry so the first move doesn't jump. `size` may be
    // absent (an auto-sized container), which is also what a rejected resize must restore.
    const start = board.containerSize(block.id)
    const from = {
      position: { ...block.position },
      size: block.size ? { ...block.size } : undefined,
    }
    // The floors, snapshotted once: on an origin-axis drag the children MOVE, so a floor re-read
    // mid-drag would chase them. `contentSize` bounds the far edge; the near-edge bound applies
    // only where the origin travels, and only inwards.
    const min = board.contentSize(block.id)
    const slack = originSlack(block.id)
    const floor = {
      w: handle.ox ? Math.max(min.w, start.w - slack.x) : min.w,
      h: handle.oy ? Math.max(min.h, start.h - slack.y) : min.h,
    }
    resizingId.value = block.id

    // Hold the resize cursor on `<body>` (and kill text selection) for the whole drag: the
    // pointer routinely outruns the 12px grip, and without this the cursor flips back to the
    // default mid-drag, which reads as "the grab was dropped" even though the border is still
    // tracking.
    const body = document.body
    const priorCursor = body.style.cursor
    const priorUserSelect = body.style.userSelect
    body.style.cursor = handle.cursor
    body.style.userSelect = 'none'

    let bounds = { position: from.position, size: start }
    let moved = false
    const onMove = (ev: PointerEvent) => {
      const z = ui.zoom || 1
      const dx = (ev.clientX - startX) / z
      const dy = (ev.clientY - startY) / z
      const w = Math.round(Math.max(floor.w, start.w + handle.sx * dx))
      const h = Math.round(Math.max(floor.h, start.h + handle.sy * dy))
      // A grown box on an origin axis extends BACKWARDS from where the far edge stays put, so
      // the origin moves by whatever the size actually gained after clamping.
      bounds = {
        position: {
          x: from.position.x - handle.ox * (w - start.w),
          y: from.position.y - handle.oy * (h - start.h),
        },
        size: { w, h },
      }
      moved = true
      // Optimistic, local-only (the store also translates the children): no round-trip per move.
      board.previewResize(block.id, bounds.position, bounds.size)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      body.style.cursor = priorCursor
      body.style.userSelect = priorUserSelect
      // A press with no movement is not a resize: committing it would emit a coarse board signal
      // (every other client re-hydrates) to store the geometry it already had.
      //
      // Committed BEFORE the id is released, matching `useBlockDrag`'s drop: `resizeBlock` applies
      // the final bounds optimistically, and the overlap guard settles the board on the release of
      // this id, so clearing it first would have the guard read the geometry of a resize that had
      // not landed yet.
      if (moved) void board.resizeBlock(block.id, bounds, from)
      resizingId.value = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    // A cancelled pointer (touch interrupted by a gesture, window losing the pointer) never fires
    // `pointerup`, so without this the body cursor stays stuck on `ew-resize` for the session.
    window.addEventListener('pointercancel', onUp)
  }

  return { resizingId, startResize }
}
