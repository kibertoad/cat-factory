/**
 * Pure ranking for the task-expansion gate (see `composables/useTaskExpansion.ts`).
 *
 * Task cards are stacked in a frame and project their footprint DOWN to their expanded
 * height, so the screen centre lands inside several footprints at once: a tall card
 * growing down from above covers it just as much as the card whose stored band the
 * centre actually sits in. Ranking by "distance to footprint, 0 when inside" ties every
 * covering card at 0, and the tie then breaks by document order — which is how a stacked
 * neighbour steals the grant from the card you're looking at.
 *
 * Ownership fixes that: a card the centre is INSIDE ranks ahead of every card it isn't,
 * and among owners the one whose top is nearest above the centre wins (its native band
 * holds the centre, rather than a neighbour bleeding down over it). Non-owners fall back
 * to the centre's squared distance to their footprint. Footprint tops don't move as cards
 * grow downward, so the ordering can't oscillate as cards expand / collapse.
 */
export type Rect = { left: number; right: number; top: number; bottom: number }

export type Ownership = { inside: boolean; key: number }

/** Where the screen centre `(cx, cy)` sits relative to a card's projected footprint. */
export function centreOwnership(footprint: Rect, cx: number, cy: number): Ownership {
  const inside =
    footprint.left <= cx &&
    footprint.right >= cx &&
    footprint.top <= cy &&
    footprint.bottom >= cy
  const ddx = Math.max(footprint.left - cx, 0, cx - footprint.right)
  const ddy = Math.max(footprint.top - cy, 0, cy - footprint.bottom)
  // Owners: shallowest centre-below-top first. Non-owners: nearest footprint first.
  return { inside, key: inside ? cy - footprint.top : ddx * ddx + ddy * ddy }
}

/** Sort comparator: owners before non-owners, then by the tie-break key ascending. */
export function compareOwnership(a: Ownership, b: Ownership): number {
  return a.inside === b.inside ? a.key - b.key : a.inside ? -1 : 1
}
