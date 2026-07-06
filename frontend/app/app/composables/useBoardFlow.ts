import { useVueFlow } from '@vue-flow/core'

/** Stable id for the main board's Vue Flow instance. Passing this id to
 * useVueFlow() from anywhere (e.g. the toolbar) accesses the same instance. */
export const BOARD_FLOW_ID = 'board'

/** Camera zoom clamps — the single source of truth shared by the canvas (which passes
 * them to <VueFlow>) and the toolbar (which disables its zoom buttons at the limits). */
export const BOARD_MIN_ZOOM = 0.2
export const BOARD_MAX_ZOOM = 3

/** Camera controls for the main board, usable outside the canvas component. */
export function useBoardFlow() {
  const { fitView, zoomIn, zoomOut, zoomTo, viewport } = useVueFlow(BOARD_FLOW_ID)
  /** Snap the camera back to 100% zoom (keeps the current centre). */
  const resetZoom = () => zoomTo(1, { duration: 250 })
  return { fitView, zoomIn, zoomOut, zoomTo, resetZoom, viewport }
}
