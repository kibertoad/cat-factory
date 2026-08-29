import { computed, watch } from 'vue'
import { tryOnScopeDispose } from '@vueuse/core'
import { useBlockDrag } from '~/composables/useBlockDrag'
import { useFrameResize } from '~/composables/useFrameResize'
import {
  EPIC_NODE_SIZE,
  changedRectIds,
  resolveFrameOverlaps,
  type FrameRect,
  type PlacedRect,
  type Point,
} from '~/utils/framePlacement'

/**
 * How long a correction waits before it is written back. Purely a coalescing window: the local
 * board is corrected on the spot, so nothing ever RENDERS overlapping. This only stops a burst
 * of live events (a hydrate, then the per-block upserts behind it) from turning one settled
 * layout into a write per intermediate state.
 */
const PERSIST_DEBOUNCE_MS = 250

/**
 * The board's standing "no two frames overlap" invariant.
 *
 * Frames used to be rendered exactly where they were stored and allowed to overlap freely, with
 * hover-driven stacking as the way to reach the one underneath. That only ever worked for the
 * frame you were pointing at: everything under a neighbour was invisible, and nothing on the
 * board said it was there. Placement already refused to CREATE an overlap
 * (`findFreeFramePosition`), but three later events could still make one (dragging a frame onto
 * a neighbour, dragging a border out into one, and a frame growing when its first task arrives,
 * since an empty service reserves a much smaller footprint than one rendering lanes), so the rule
 * was true of a board nobody had touched and of no other.
 *
 * This closes it as an invariant rather than as a check on each of those writes: it watches the
 * rendered geometry of every top-level board node and, whenever two come to overlap, bounces them
 * apart (`resolveFrameOverlaps`). Being cause-agnostic is the point: a future write that moves
 * or grows a frame is covered without knowing this exists.
 *
 * Two decisions worth knowing before changing it:
 *
 * - **It runs in the SPA, not the backend.** A frame's footprint is derived from the lane
 *   geometry the browser renders it at (`containerSize`), which the server cannot compute: it
 *   stores a position and, at most, a size override. So the only layer that can tell whether two
 *   frames overlap is the one drawing them, and the correction is persisted through the ordinary
 *   move write.
 * - **Every client resolves independently, and that is safe** because `resolveFrameOverlaps` is a
 *   pure function of the same rects each of them holds: two browsers looking at one board compute
 *   the same corrected positions and write the same values, rather than fighting over it.
 *
 * Epics take part as well as frames. They are top-level nodes on the same canvas (placement
 * already reserves space around them), so an epic card parked over a frame hides exactly as much
 * of it as another frame would.
 */
export function useFrameOverlapGuard() {
  const board = useBoardStore()
  const access = useWorkspaceAccess()
  const { draggingId } = useBlockDrag()
  const { resizingId } = useFrameResize()

  /** Every top-level node's rendered rect, in the flow-space coordinates blocks are stored in. */
  const nodeRects = computed<PlacedRect[]>(() => [
    ...board.frames.map((f) => {
      const size = board.containerSize(f.id)
      return { id: f.id, x: f.position.x, y: f.position.y, w: size.w, h: size.h }
    }),
    ...board.epics.map((e) => ({
      id: e.id,
      x: e.position.x,
      y: e.position.y,
      ...EPIC_NODE_SIZE,
    })),
  ])

  /** The geometry the last pass settled on, so the next one can name what actually changed. */
  let settled = new Map<string, FrameRect>()
  /** Corrections applied locally whose write is still owed. */
  const owed = new Map<string, Point>()
  let persistTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Write back the corrections we have applied locally.
   *
   * Held while a drag or a border resize is still running, for the reason `previewMove` exists:
   * the pointer produces a new layout on every move, and persisting each one races, since a late
   * response landing a stale position last would make the board jump after the user let go. The
   * bounced neighbours are already where the user can see them; the write is what waits.
   *
   * A read-only viewer corrects the board it is looking at and writes nothing: the invariant is
   * about what is visible, and `board.write` is not theirs to spend (the backend's viewer floor
   * would refuse it anyway).
   */
  function persist() {
    if (draggingId.value || resizingId.value) return
    if (access.canWriteBoard.value) {
      for (const [id, position] of owed) {
        const current = board.getBlock(id)?.position
        // Skip a correction something newer has already moved past: it would write back a
        // position that is no longer the one on screen.
        if (current && current.x === position.x && current.y === position.y) {
          void board.moveBlock(id, position)
        }
      }
    }
    owed.clear()
  }

  function schedulePersist() {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(persist, PERSIST_DEBOUNCE_MS)
  }

  function separate(rects: PlacedRect[]) {
    // The frame under the pointer is the first anchor whatever else changed with it: it is the
    // one the user is placing, so it keeps the spot they aimed at and its neighbours move aside.
    const interactive = draggingId.value ?? resizingId.value
    const anchorIds = [...(interactive ? [interactive] : []), ...changedRectIds(settled, rects)]
    const moved = resolveFrameOverlaps(rects, { anchorIds })
    // Record the resolved geometry, not the incoming one, so this pass's own corrections do not
    // read as a change next time round (which would anchor them and defeat the reading order).
    settled = new Map(rects.map((r) => [r.id, { ...r, ...moved.get(r.id) }]))
    if (moved.size === 0) return
    for (const [id, position] of moved) {
      board.previewMove(id, position)
      owed.set(id, position)
    }
    schedulePersist()
  }

  // Default `pre` flush: the correction is applied before the board re-renders, so an overlap
  // never reaches the screen even for one frame. Re-entrant by construction (applying it
  // invalidates `nodeRects`), but the second pass finds a settled board and stops there.
  watch(nodeRects, separate, { immediate: true })

  // A drag or resize ending is not itself a geometry change (the guard bounced the neighbours
  // while it ran), so the write it was holding needs its own trigger.
  watch([draggingId, resizingId], ([drag, resize]) => {
    if (!drag && !resize && owed.size > 0) schedulePersist()
  })

  tryOnScopeDispose(() => {
    if (persistTimer) clearTimeout(persistTimer)
  })
}
