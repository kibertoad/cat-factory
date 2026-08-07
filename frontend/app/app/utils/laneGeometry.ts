/**
 * The swimlane layout's fixed pixel geometry, and the two functions that derive a frame's size
 * from it.
 *
 * One module rather than numbers spread across the components, because three consumers have to
 * agree exactly: `useBlockQueries.contentSize` computes the frame's minimum size, `FrameSwimlanes`
 * renders into that space, and `framePlacement` reserves a spot for a frame that does not exist
 * yet. When they disagree the lanes are clipped by their own frame or a new service is dropped on
 * top of its neighbour, both of which look like rendering bugs rather than a stale constant. That
 * is why the two derivations below are FUNCTIONS here rather than arithmetic at each call site:
 * a constant restating the result is exactly the thing that went stale.
 *
 * These are DELIBERATELY fixed rather than derived from content. A lane scrolls; it does not
 * grow. The frame of a service with 300 open tasks is the same size as one with three, which is
 * what keeps a board of many services readable — the old free-layout frames grew with their task
 * count until the busiest service dwarfed everything around it. A reader who wants more room
 * drags the frame's border, and the stored size raises the floor these numbers set.
 */
export const LANE_GEOMETRY = {
  /** Card width, matching the task card's own fixed width. */
  cardWidth: 210,
  /** One lane column: a card plus its gutters. */
  laneWidth: 226,
  /** Gap between lane columns. */
  laneGap: 8,
  /** The three live lanes plus the gaps and the canvas's own padding. */
  canvasWidth: 226 * 3 + 8 * 2 + 16,
  /** A lane's scrolling body, at the frame's floor size. */
  laneBodyHeight: 420,
  /** A lane's header (label, count, the withheld-count line on the Done lane). */
  laneHeaderHeight: 34,
  /** The collapsed Done strip's header row. */
  doneStripHeight: 32,
  /** An initiative card in the band above the lanes. */
  initiativeWidth: 240,
  initiativeHeight: 176,
  /**
   * A service with no children at all renders one "add the first task" panel and no lanes, so it
   * reserves the panel's footprint rather than the lanes'. Sizing an empty service as though the
   * lanes were there would leave every new frame two and a half times taller than the thing
   * inside it, and would push its neighbours that much further away for nothing.
   */
  emptyFrameWidth: 360,
  emptyFrameHeight: 220,
} as const

/** What the frame lays out itself, which is everything its height cannot derive from a lane. */
export interface FrameContent {
  /**
   * Whether the frame renders lanes at all: it has tasks, modules or initiatives under it. The
   * same predicate `BlockNode` gates `FrameSwimlanes` on, because a size that disagrees with
   * what rendered is the clipping bug this module exists to prevent.
   */
  readonly hasChildren: boolean
  /** Initiative cards, which sit in a wrapping band above the lanes. */
  readonly initiatives: number
}

/** How many initiative cards fit across a canvas `width` px wide. */
function initiativeRows(count: number, width: number): number {
  const perRow = Math.max(1, Math.floor(width / LANE_GEOMETRY.initiativeWidth))
  return Math.ceil(count / perRow)
}

/**
 * The smallest size that fits a frame's swimlanes and its initiative band: the floor a resizable
 * frame can never be dragged below, and the footprint a placement decision reserves for one that
 * does not exist yet.
 */
export function frameContentSize(content: FrameContent): { w: number; h: number } {
  if (!content.hasChildren) {
    return { w: LANE_GEOMETRY.emptyFrameWidth, h: LANE_GEOMETRY.emptyFrameHeight }
  }
  const w = LANE_GEOMETRY.canvasWidth
  return {
    w,
    h:
      initiativeRows(content.initiatives, w) * LANE_GEOMETRY.initiativeHeight +
      LANE_GEOMETRY.laneBodyHeight +
      LANE_GEOMETRY.laneHeaderHeight +
      LANE_GEOMETRY.doneStripHeight,
  }
}

/**
 * How tall a lane's scrolling body is inside a frame of `size`.
 *
 * The inverse of {@link frameContentSize}: the room left once the initiative band, the lane
 * headers and the collapsed Done strip have taken theirs. A frame at its floor size gets exactly
 * `laneBodyHeight` back, and a frame the reader has dragged taller gives the whole difference to
 * the lanes — which is the point of dragging it. Without this the lanes kept their constant
 * height and the extra space was dead canvas below them, so the gesture appeared to do nothing.
 *
 * Never returns less than `laneBodyHeight`: a frame can be dragged no smaller than its floor, and
 * a caller measuring one mid-layout should not be able to collapse a lane to nothing.
 */
export function laneBodyHeightIn(size: { w: number; h: number }, initiatives: number): number {
  const room =
    size.h -
    initiativeRows(initiatives, size.w) * LANE_GEOMETRY.initiativeHeight -
    LANE_GEOMETRY.laneHeaderHeight -
    LANE_GEOMETRY.doneStripHeight
  return Math.max(LANE_GEOMETRY.laneBodyHeight, room)
}
