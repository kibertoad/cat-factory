/**
 * The swimlane layout's fixed pixel geometry.
 *
 * One module rather than numbers spread across the components, because two consumers have to
 * agree exactly: `useBlockQueries.contentSize` computes the frame's minimum size from these,
 * and `FrameSwimlanes` renders into that space. When they disagree the lanes are clipped by
 * their own frame, which looks like a rendering bug rather than a stale constant.
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
  /** A lane's scrolling body. */
  laneBodyHeight: 420,
  /** A lane's header (label, count, the withheld-count line on the Done lane). */
  laneHeaderHeight: 34,
  /** The collapsed Done strip's header row. */
  doneStripHeight: 32,
  /** An initiative card in the band above the lanes. */
  initiativeWidth: 240,
  initiativeHeight: 176,
} as const
