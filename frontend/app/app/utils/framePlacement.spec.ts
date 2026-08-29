import { describe, it, expect } from 'vitest'
import {
  changedRectIds,
  findFreeFramePosition,
  framesCollide,
  resolveFrameOverlaps,
  FRAME_GAP,
  type FrameRect,
  type PlacedRect,
} from './framePlacement'

const size = { w: 360, h: 220 }

describe('framesCollide', () => {
  it('reports overlapping rects as colliding', () => {
    const a: FrameRect = { x: 0, y: 0, w: 100, h: 100 }
    const b: FrameRect = { x: 50, y: 50, w: 100, h: 100 }
    expect(framesCollide(a, b)).toBe(true)
  })

  it('treats rects separated by a clear channel as not colliding', () => {
    const a: FrameRect = { x: 0, y: 0, w: 100, h: 100 }
    const b: FrameRect = { x: 200, y: 0, w: 100, h: 100 }
    expect(framesCollide(a, b)).toBe(false)
  })

  it('honours the gap margin: touching-but-clear rects collide once a gap is required', () => {
    const a: FrameRect = { x: 0, y: 0, w: 100, h: 100 }
    const b: FrameRect = { x: 100, y: 0, w: 100, h: 100 } // flush against `a`
    expect(framesCollide(a, b)).toBe(false) // no gap: exactly touching clears
    expect(framesCollide(a, b, 1)).toBe(true) // any required gap is violated
  })
})

describe('findFreeFramePosition', () => {
  it('returns the desired spot verbatim when it is already free', () => {
    const desired = { x: 500, y: 500 }
    expect(findFreeFramePosition([], size, desired)).toEqual(desired)
  })

  it('keeps a deliberate drop that clears every existing frame', () => {
    const existing: FrameRect[] = [{ x: 0, y: 0, ...size }]
    const desired = { x: 900, y: 0 }
    expect(findFreeFramePosition(existing, size, desired)).toEqual(desired)
  })

  it('moves off a spot that overlaps an existing frame, and the result clears it', () => {
    const existing: FrameRect[] = [{ x: 0, y: 0, ...size }]
    const desired = { x: 40, y: 20 } // squarely on top of the existing frame
    const placed = findFreeFramePosition(existing, size, desired)
    const placedRect: FrameRect = { ...placed, ...size }
    expect(framesCollide(placedRect, existing[0]!, FRAME_GAP)).toBe(false)
  })

  it('finds a free cell even when the desired spot is boxed in by neighbours', () => {
    // Frames all around the origin; the desired centre cell is taken and crowded.
    const step = size.w + FRAME_GAP
    const existing: FrameRect[] = [
      { x: 0, y: 0, ...size },
      { x: step, y: 0, ...size },
      { x: -step, y: 0, ...size },
      { x: 0, y: size.h + FRAME_GAP, ...size },
    ]
    const placed = findFreeFramePosition(existing, size, { x: 0, y: 0 })
    const placedRect: FrameRect = { ...placed, ...size }
    for (const r of existing) {
      expect(framesCollide(placedRect, r, FRAME_GAP)).toBe(false)
    }
  })

  it('places the nearest free cell to the desired point', () => {
    // Only the desired cell is occupied; the closest free cell is one step away.
    const existing: FrameRect[] = [{ x: 0, y: 0, ...size }]
    const placed = findFreeFramePosition(existing, size, { x: 0, y: 0 })
    const step = size.w + FRAME_GAP
    // The nearest ring cell is a single frame-step away on one axis.
    const dist = Math.hypot(placed.x, placed.y)
    expect(dist).toBeLessThanOrEqual(Math.hypot(step, step) + 1)
    expect(dist).toBeGreaterThan(0)
  })
})

/** Every pair on the resolved board clears the gap: the invariant the guard exists to hold. */
function assertNoOverlap(rects: PlacedRect[], moved: Map<string, { x: number; y: number }>) {
  const settled = rects.map((r) => ({ ...r, ...moved.get(r.id) }))
  for (const [i, a] of settled.entries()) {
    for (const b of settled.slice(i + 1)) {
      expect({ pair: [a.id, b.id], collides: framesCollide(a, b, FRAME_GAP) }).toEqual({
        pair: [a.id, b.id],
        collides: false,
      })
    }
  }
}

describe('resolveFrameOverlaps', () => {
  it('leaves a board whose frames already clear each other untouched', () => {
    const rects: PlacedRect[] = [
      { id: 'a', x: 0, y: 0, ...size },
      { id: 'b', x: size.w + FRAME_GAP, y: 0, ...size },
    ]
    expect(resolveFrameOverlaps(rects)).toEqual(new Map())
  })

  it('bounces the neighbour off an anchored frame dropped on top of it, keeping the drop', () => {
    const rects: PlacedRect[] = [
      { id: 'dropped', x: 40, y: 0, ...size },
      { id: 'sitting', x: 0, y: 0, ...size },
    ]
    const moved = resolveFrameOverlaps(rects, { anchorIds: ['dropped'] })
    // The frame the user placed keeps the exact spot they aimed at.
    expect(moved.has('dropped')).toBe(false)
    expect(moved.has('sitting')).toBe(true)
    assertNoOverlap(rects, moved)
  })

  it('takes the shortest way out: a small overlap moves by a little, not a whole frame', () => {
    const rects: PlacedRect[] = [
      { id: 'anchor', x: 0, y: 0, ...size },
      { id: 'nudged', x: size.w - 10, y: 0, ...size },
    ]
    const moved = resolveFrameOverlaps(rects, { anchorIds: ['anchor'] })
    // Clearing rightwards costs 10px of penetration plus the gap; going around would cost a
    // whole frame width.
    expect(moved.get('nudged')).toEqual({ x: size.w + FRAME_GAP, y: 0 })
  })

  it('separates a frame that grew into its neighbour, keeping the grown frame in place', () => {
    // An empty service (360x220) with a neighbour placed a gap away, then its first task
    // arrives and it grows to the lane footprint.
    const grown = { w: 694, h: 486 }
    const rects: PlacedRect[] = [
      { id: 'grown', x: 0, y: 0, ...grown },
      { id: 'neighbour', x: 360 + FRAME_GAP, y: 0, ...size },
    ]
    const moved = resolveFrameOverlaps(rects, { anchorIds: ['grown'] })
    expect(moved.has('grown')).toBe(false)
    assertNoOverlap(rects, moved)
  })

  it('untangles a pile of frames stacked on one spot', () => {
    const rects: PlacedRect[] = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, x: 0, y: 0, ...size }))
    assertNoOverlap(rects, resolveFrameOverlaps(rects))
  })

  it('answers the same way whatever order the rects arrive in', () => {
    const rects: PlacedRect[] = [
      { id: 'a', x: 0, y: 0, ...size },
      { id: 'b', x: 30, y: 20, ...size },
      { id: 'c', x: 60, y: 500, ...size },
      { id: 'd', x: 10, y: 480, ...size },
    ]
    // Two clients hold the same board in whatever order their events arrived; a resolution that
    // depended on that order would have them write different positions and fight.
    const first = resolveFrameOverlaps(rects)
    const second = resolveFrameOverlaps([...rects].reverse())
    expect([...second].sort()).toEqual([...first].sort())
  })

  it('is idempotent: re-running over the resolved board moves nothing', () => {
    const rects: PlacedRect[] = [
      { id: 'a', x: 0, y: 0, ...size },
      { id: 'b', x: 12, y: 8, ...size },
      { id: 'c', x: 24, y: 16, ...size },
    ]
    const moved = resolveFrameOverlaps(rects)
    const settled = rects.map((r) => ({ ...r, ...moved.get(r.id) }))
    expect(resolveFrameOverlaps(settled)).toEqual(new Map())
  })

  it('clears fractional positions outright, so a pass cannot leave a sub-pixel to shave again', () => {
    // A drag divides the pointer delta by the board zoom, so the stored positions really are
    // fractional; rounding a correction the wrong way would leave a sliver of overlap behind.
    const rects: PlacedRect[] = [
      { id: 'a', x: 0.5, y: 0.25, ...size },
      { id: 'b', x: 10.75, y: 0.5, ...size },
    ]
    const moved = resolveFrameOverlaps(rects, { anchorIds: ['a'] })
    assertNoOverlap(rects, moved)
    const settled = rects.map((r) => ({ ...r, ...moved.get(r.id) }))
    expect(resolveFrameOverlaps(settled, { anchorIds: ['a'] })).toEqual(new Map())
  })
})

describe('changedRectIds', () => {
  const previous = new Map<string, FrameRect>([
    ['a', { x: 0, y: 0, ...size }],
    ['b', { x: 500, y: 0, ...size }],
  ])

  it('reports a rect that moved and one that only changed size', () => {
    expect(
      changedRectIds(previous, [
        { id: 'a', x: 40, y: 0, ...size },
        { id: 'b', x: 500, y: 0, w: size.w, h: size.h + 100 },
      ]),
    ).toEqual(['a', 'b'])
  })

  it('reports nothing for an unchanged board', () => {
    expect(
      changedRectIds(previous, [
        { id: 'a', x: 0, y: 0, ...size },
        { id: 'b', x: 500, y: 0, ...size },
      ]),
    ).toEqual([])
  })

  it('does not report a rect it has never seen, so an arriving frame yields to the board', () => {
    expect(changedRectIds(previous, [{ id: 'new', x: 0, y: 0, ...size }])).toEqual([])
  })
})
