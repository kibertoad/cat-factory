import { useVueFlow } from '@vue-flow/core'

/** Stable id for the main board's Vue Flow instance. Passing this id to
 * useVueFlow() from anywhere (e.g. the toolbar) accesses the same instance. */
export const BOARD_FLOW_ID = 'board'

/** Camera controls for the main board, usable outside the canvas component. */
export function useBoardFlow() {
  const { fitView, zoomIn, zoomOut, viewport } = useVueFlow(BOARD_FLOW_ID)
  return { fitView, zoomIn, zoomOut, viewport }
}
