/**
 * The board's Vue Flow node projection, and the memo that keeps a hover cheap.
 *
 * Only frames and epics are canvas nodes (tasks live inside their frame, laid out in swimlanes).
 * The projection is trivial, but it is recomputed for a reason that has nothing to do with the
 * board changing: a frame's `zIndex` encodes the STACKING state (which frame is being dragged,
 * which is hovered), so every pointer move between two overlapping services re-derived the whole
 * array, and Vue Flow re-diffed every node in it against a set of freshly allocated objects that
 * were, for all but one or two, identical to the ones it already held.
 *
 * Memoising per node fixes that without changing what the array contains: the key carries every
 * field the node has, so a node whose fields are unchanged comes back as the SAME object and a
 * changed one is rebuilt. A hover then allocates two nodes instead of all of them, and Vue Flow's
 * diff sees two changes instead of N.
 *
 * The cache is rebuilt from the hits of each pass, so a deleted frame's entry does not outlive it.
 */
export interface BoardNodeSource {
  id: string
  position: { x: number; y: number }
}

export interface BoardFlowNode {
  id: string
  type: 'block' | 'epic'
  position: { x: number; y: number }
  draggable: boolean
  zIndex?: number
  data: Record<string, never>
}

/** Where a frame sits in the stack: dragged on top, then hovered, then everything else. */
export interface FrameStacking {
  draggingId: string | null
  hoveredFrameId: string | null
}

/**
 * Vue Flow's `elevate-nodes-on-select` is OFF (see BoardCanvas), so stacking is driven purely by
 * these two: the frame being dragged is lifted above all, then the hovered one (the un-obscured
 * frame under the pointer), so overlapping services can always be reached and reordered.
 */
export function frameZIndex(id: string, stacking: FrameStacking): number {
  if (stacking.draggingId === id) return 1000
  if (stacking.hoveredFrameId === id) return 100
  return 1
}

export function createBoardNodeProjection() {
  let cache = new Map<string, BoardFlowNode>()

  return function project(
    frames: readonly BoardNodeSource[],
    epics: readonly BoardNodeSource[],
    stacking: FrameStacking,
  ): BoardFlowNode[] {
    const next = new Map<string, BoardFlowNode>()
    const nodes: BoardFlowNode[] = []

    const take = (key: string, build: () => BoardFlowNode) => {
      const node = cache.get(key) ?? build()
      next.set(key, node)
      nodes.push(node)
    }

    for (const frame of frames) {
      const zIndex = frameZIndex(frame.id, stacking)
      take(`block|${frame.id}|${frame.position.x}|${frame.position.y}|${zIndex}`, () => ({
        id: frame.id,
        type: 'block',
        position: { x: frame.position.x, y: frame.position.y },
        // Always-expanded frames fill the viewport; keep them non-draggable so the pane pans
        // through them (they move via their header handle, see BlockNode).
        draggable: false,
        zIndex,
        data: {},
      }))
    }
    for (const epic of epics) {
      take(`epic|${epic.id}|${epic.position.x}|${epic.position.y}`, () => ({
        id: epic.id,
        type: 'epic',
        position: { x: epic.position.x, y: epic.position.y },
        draggable: true,
        data: {},
      }))
    }

    cache = next
    return nodes
  }
}
