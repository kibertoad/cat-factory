import { computed, watch } from 'vue'
import { useBlockDrag } from '~/composables/useBlockDrag'
import { useFrameResize } from '~/composables/useFrameResize'
import { EPIC_NODE_SIZE, resolveFrameOverlaps, type PlacedRect } from '~/utils/framePlacement'

/**
 * The board's standing "no two top-level nodes overlap" invariant.
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
 * apart (`resolveFrameOverlaps`). Being cause-agnostic is the point: a future write that moves or
 * grows a frame is covered without knowing this exists.
 *
 * ## Correcting the view and writing the correction are two different jobs
 *
 * They have opposite requirements, and the guard keeps them apart, because conflating them is
 * what makes a layout fixer fight itself across clients:
 *
 * - **Every client corrects what it DRAWS, always.** `resolveFrameOverlaps` is a pure function of
 *   the rects, so this needs no coordination: two browsers holding one board draw it the same way
 *   whatever order their events arrived in. A read-only viewer gets the corrected view for free,
 *   which is the point (the invariant is about what is VISIBLE).
 * - **Exactly one client may WRITE a correction, and only a local GESTURE elects it.** A drag or
 *   a border resize has an unambiguous single author: the browser the pointer is in. That client
 *   settles the board when the gesture ends and persists the neighbours it displaced.
 *
 * So a correction is persisted only where the local user caused it. That is a deliberate limit,
 * not an oversight, and the third cause above is what it costs: a frame that grows on its own has
 * NO author (the task may have arrived from a pipeline, with no browser involved), so its
 * correction is DRAWN everywhere and WRITTEN by nobody. The stored position stays the one someone
 * chose, and the board derives a clear presentation from it, this session and the next.
 *
 * The alternative is worse in both directions. Having every writer-capable client persist what it
 * resolved costs a write and a board-wide event per open session for one overlap, and the first of
 * those writes moves the geometry the others are still resolving. And a persisted correction is
 * not even the better answer where it lands: a frame that grew for its first task shrinks again
 * when that task is deleted, and a neighbour bounced by a WRITE stays where it was pushed, while a
 * neighbour bounced by a projection is recomputed off the server's own geometry on the next
 * hydrate and simply comes back.
 *
 * ## Why it runs in the SPA
 *
 * A frame's footprint is derived from the lane geometry the browser renders it at
 * (`containerSize`), which the server cannot compute: it stores a position and, at most, a size
 * override. So the only layer that can tell whether two frames overlap is the one drawing them.
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

  /** The node the local pointer is placing right now, if any. */
  const gestureId = computed(() => draggingId.value ?? resizingId.value)

  /**
   * Bounce the overlapping nodes apart, holding `anchorId` still.
   *
   * `persist` picks the channel, and the two are mutually exclusive on purpose.
   * {@link useBoardStore.moveBlock} ALREADY applies its position optimistically and restores the
   * previous one if the write is refused, so it is both the local correction and the write. A
   * `previewMove` ahead of it would break exactly that: `moveBlock` snapshots the position it
   * finds, so a rollback would restore the correction rather than undo it, leaving the SPA
   * showing a position the server never stored.
   */
  function bounce(anchorId: string | null, persist: boolean) {
    for (const [id, position] of resolveFrameOverlaps(nodeRects.value, { anchorId })) {
      if (persist) void board.moveBlock(id, position)
      else board.previewMove(id, position)
    }
  }

  /**
   * Draw the board clear, on every client, writing nothing.
   *
   * Held for the duration of a gesture. A drag previews a new position on every pointer move, and
   * bouncing neighbours off those in-flight positions displaces frames the user is only passing
   * OVER: each pass reads the neighbour at the spot the previous pass pushed it to, so the
   * displacement accumulates instead of springing back, and a drag across a populated board
   * rearranges services nobody touched. A frame drawn on top of its neighbours while the pointer
   * is holding it is what direct manipulation looks like; the board settles when it is let go.
   *
   * Anchorless, because a change with no local gesture behind it has no frame the user is
   * placing: it is a growth, or another client's write arriving. Reading order decides, and it is
   * the same reading order everywhere.
   */
  function project() {
    if (gestureId.value) return
    bounce(null, false)
  }

  // Default `pre` flush: the correction is applied before the board re-renders, so an overlap
  // never reaches the screen even for one frame. Re-entrant by construction (correcting a
  // position invalidates `nodeRects`), but `resolveFrameOverlaps` is idempotent, so the second
  // pass finds a settled board and stops there.
  watch(nodeRects, project, { immediate: true })

  /**
   * Settle the board around the node the local user just placed, and persist what moved.
   *
   * `post` flush so the gesture's own commit has landed first: a drop calls `moveBlock` (and a
   * released border `resizeBlock`) before clearing the id, and both apply their geometry
   * optimistically, so by the time this runs `nodeRects` already holds the placed node's final
   * footprint. The resolution is therefore computed from live geometry rather than replayed from
   * anything the gesture accumulated, which is what makes every way a gesture can end correct
   * without a case for each: a `pointercancel` (or the dragged component unmounting) restores the
   * pre-drag position, so this finds a clear board and writes nothing at all.
   */
  watch(
    gestureId,
    (now, before) => {
      if (now || !before) return
      // Access can be revoked mid-session; a viewer still gets the corrected view.
      bounce(before, access.canWriteBoard.value)
    },
    { flush: 'post' },
  )
}
