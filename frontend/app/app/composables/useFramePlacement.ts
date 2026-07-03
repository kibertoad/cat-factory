import { nextTick } from 'vue'
import { useVueFlow } from '@vue-flow/core'
import { BOARD_FLOW_ID } from '~/composables/useBoardFlow'
import {
  EMPTY_FRAME_SIZE,
  findFreeFramePosition,
  type Point,
  type FrameRect,
} from '~/utils/framePlacement'

/**
 * Placement + camera helpers for adding a service frame to the board, honouring the
 * house rule: a new frame never overlaps an existing one and the camera centres on it.
 *
 * The board (Vue Flow) is the single source of truth for the camera, so this lives in a
 * composable rather than the board store — every "add a frame" call site (palette drop,
 * repo import, repo bootstrap) runs it right after the block exists.
 */

/**
 * The floor we snap the camera zoom up to when centring a new frame, so one added while
 * the board is zoomed far out still lands legibly on screen. We only ever zoom the user
 * *in* to this floor — a closer zoom is left alone (`Math.max`).
 */
const MIN_FOCUS_ZOOM = 0.6

export function useFramePlacement() {
  const board = useBoardStore()
  const { viewport, setCenter, screenToFlowCoordinate } = useVueFlow(BOARD_FLOW_ID)

  /** Every existing frame's rect in flow-space (its stored position + rendered size). */
  function existingFrameRects(exclude?: string): FrameRect[] {
    return board.frames
      .filter((f) => f.id !== exclude)
      .map((f) => {
        const s = board.containerSize(f.id)
        return { x: f.position.x, y: f.position.y, w: s.w, h: s.h }
      })
  }

  /**
   * The flow-space top-left at which a frame of `size` would sit centred in the
   * current view — the natural anchor for a frame added without a specific drop point
   * (repo import / bootstrap), so it appears where the user is already looking.
   */
  function viewportCenteredAnchor(size: { w: number; h: number }): Point {
    const c = screenToFlowCoordinate({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
    return { x: c.x - size.w / 2, y: c.y - size.h / 2 }
  }

  /**
   * A non-overlapping top-left for a new frame. `near` is the preferred spot (a drop
   * cursor's flow coords); omitted, the frame is anchored to the centre of the current
   * view. `exclude` skips a frame's own rect when re-placing one that already exists
   * (bootstrap re-homes its provisional frame).
   */
  function freeFramePosition(opts?: {
    near?: Point
    size?: { w: number; h: number }
    exclude?: string
  }): Point {
    const size = opts?.size ?? EMPTY_FRAME_SIZE
    const desired = opts?.near ?? viewportCenteredAnchor(size)
    return findFreeFramePosition(existingFrameRects(opts?.exclude), size, desired)
  }

  /** Pan (and, if zoomed far out, gently zoom in) the camera to centre on a frame. */
  async function focusFrame(id: string, opts?: { duration?: number }): Promise<void> {
    const frame = board.getBlock(id)
    if (!frame) return
    const s = board.containerSize(id)
    const cx = frame.position.x + s.w / 2
    const cy = frame.position.y + s.h / 2
    const zoom = Math.max(viewport.value.zoom, MIN_FOCUS_ZOOM)
    // Let any layout the caller just triggered (e.g. the inspector opening on select)
    // settle so the centre is computed against the real pane size.
    await nextTick()
    setCenter(cx, cy, { zoom, duration: opts?.duration ?? 400 })
  }

  return { freeFramePosition, focusFrame }
}
