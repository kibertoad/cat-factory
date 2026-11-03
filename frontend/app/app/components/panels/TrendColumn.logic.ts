// Pure sizing behind `TrendColumn.vue`, unit-tested directly instead of through the DOM.

/**
 * A trend column's height as a percentage of the tallest column. A non-zero total floors at
 * `floorPct` so a single small bucket is still a visible mark rather than an apparent gap.
 * The floor applies to the column's TOTAL, once: flooring each segment on its own inflates a
 * stack of small segments past a taller single-segment column and ranks the two backwards.
 */
export function columnPct(total: number, max: number, floorPct: number): number {
  if (max <= 0 || total <= 0) return 0
  return Math.max(floorPct, (total / max) * 100)
}

/**
 * Each drawn segment's share of its column, as a percentage of the column's stack. A zero
 * segment is left out, so it takes no separator slot and no rounded corner.
 */
export function segmentShares<T extends { value: number }>(
  segments: T[],
): (T & { sharePct: number })[] {
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0)
  if (total <= 0) return []
  return segments
    .filter((s) => s.value > 0)
    .map((s) => ({ ...s, sharePct: (s.value / total) * 100 }))
}
