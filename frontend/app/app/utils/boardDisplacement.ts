/**
 * Compressed-space layout for the board. When a box (a service frame, or a task
 * card inside a frame) expands, it grows rightward / downward from its stored
 * top-left. Rather than letting the expanded footprint overlap its neighbours —
 * and then collapsing one of them to resolve the clash, which is what made a
 * zoomed-in service "snap out" as you scrolled across it — we PUSH the neighbours
 * away by the growth, so an expanded box never overlaps a neighbour it wasn't
 * already overlapping. The box stays expanded; you just scroll a bit further to
 * reach the next one.
 *
 * The result is a render-only offset per box; stored positions are never mutated.
 */
export type DisplacementBox = {
  id: string
  /** Stored top-left, in flow units. */
  x: number
  y: number
  /** Collapsed size, in flow units. */
  w: number
  h: number
  /** Extra size when expanded (0 for a collapsed box). */
  growX: number
  growY: number
}

export type Offset = { dx: number; dy: number }

/** Do the two boxes' collapsed extents overlap on the y-axis? */
function overlapsY(a: DisplacementBox, b: DisplacementBox) {
  return a.y < b.y + b.h && b.y < a.y + a.h
}

/** Do the two boxes' collapsed extents overlap on the x-axis? */
function overlapsX(a: DisplacementBox, b: DisplacementBox) {
  return a.x < b.x + b.w && b.x < a.x + a.w
}

/**
 * The render offset for every box. A box B is pushed right by the horizontal
 * growth of each expanded box E that sits to B's left (B starts past E's collapsed
 * right edge, so it isn't already overlapping E on x) and shares B's rows (their
 * collapsed y-extents overlap, so E growing rightward would actually reach B).
 * Symmetric for the downward push. Offsets only ever grow, so the function can
 * never create a new overlap, preserves left-to-right / top-to-bottom order and
 * the gaps between boxes, and chained expansions accumulate (the sum is taken from
 * the stable stored positions, so it doesn't oscillate). O(N x expanded).
 */
export function computeDisplacement(boxes: DisplacementBox[]): Map<string, Offset> {
  const expanded = boxes.filter((e) => e.growX > 0 || e.growY > 0)
  const out = new Map<string, Offset>()
  for (const b of boxes) {
    let dx = 0
    let dy = 0
    for (const e of expanded) {
      if (e.id === b.id) continue
      if (e.growX > 0 && b.x >= e.x + e.w && overlapsY(e, b)) dx += e.growX
      if (e.growY > 0 && b.y >= e.y + e.h && overlapsX(e, b)) dy += e.growY
    }
    out.set(b.id, { dx, dy })
  }
  return out
}
