import { describe, it, expect } from 'vitest'
import { computeDisplacement, type DisplacementBox } from '~/utils/boardDisplacement'

function box(p: Partial<DisplacementBox> & { id: string }): DisplacementBox {
  return { x: 0, y: 0, w: 10, h: 10, growX: 0, growY: 0, ...p }
}

describe('computeDisplacement', () => {
  it('pushes a right-hand neighbour by the expanded box growth, preserving the gap', () => {
    // A at x=0 w=10 grows by 90; B sits 20 to the right (x=30) in the same row.
    const offsets = computeDisplacement([
      box({ id: 'A', x: 0, w: 10, growX: 90 }),
      box({ id: 'B', x: 30 }),
    ])
    expect(offsets.get('A')).toEqual({ dx: 0, dy: 0 })
    // B moves right by 90, so the 20px gap (A's new right edge 100 → B's new left 120) is kept.
    expect(offsets.get('B')).toEqual({ dx: 90, dy: 0 })
  })

  it('does not push a neighbour that was already overlapping the box horizontally', () => {
    // B starts inside A's collapsed extent (x=5 < A.right=10): already overlapping, left as-is.
    const offsets = computeDisplacement([
      box({ id: 'A', x: 0, w: 10, growX: 90 }),
      box({ id: 'B', x: 5 }),
    ])
    expect(offsets.get('B')).toEqual({ dx: 0, dy: 0 })
  })

  it('accumulates the growth of every expanded box to the left (chains)', () => {
    const offsets = computeDisplacement([
      box({ id: 'A', x: 0, w: 10, growX: 90 }),
      box({ id: 'B', x: 30, w: 10, growX: 50 }),
      box({ id: 'C', x: 60 }),
    ])
    // C is right of both A and B → pushed by 90 + 50.
    expect(offsets.get('C')!.dx).toBe(140)
    // B is right of A only → pushed by 90.
    expect(offsets.get('B')!.dx).toBe(90)
  })

  it('does not cross-push boxes that are disjoint on the other axis', () => {
    // A grows rightward but B is far below it (no shared rows) → no horizontal push.
    const offsets = computeDisplacement([
      box({ id: 'A', x: 0, y: 0, w: 10, h: 10, growX: 90 }),
      box({ id: 'B', x: 30, y: 500, w: 10, h: 10 }),
    ])
    expect(offsets.get('B')).toEqual({ dx: 0, dy: 0 })
  })

  it('pushes a box below an expanded box downward', () => {
    const offsets = computeDisplacement([
      box({ id: 'A', x: 0, y: 0, w: 10, h: 10, growY: 100 }),
      box({ id: 'B', x: 0, y: 30, w: 10, h: 10 }),
    ])
    expect(offsets.get('B')).toEqual({ dx: 0, dy: 100 })
  })

  it('returns a zero offset for every box when nothing is expanded', () => {
    const offsets = computeDisplacement([box({ id: 'A', x: 0 }), box({ id: 'B', x: 30 })])
    expect(offsets.get('A')).toEqual({ dx: 0, dy: 0 })
    expect(offsets.get('B')).toEqual({ dx: 0, dy: 0 })
  })
})
