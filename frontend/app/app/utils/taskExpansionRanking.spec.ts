import { describe, it, expect } from 'vitest'
import {
  centreOwnership,
  compareOwnership,
  type Rect,
} from './taskExpansionRanking'

/** Rank a set of footprints against a screen centre, best (would-expand) first. */
function rank(footprints: Record<string, Rect>, cx: number, cy: number): string[] {
  return Object.entries(footprints)
    .map(([id, rect]) => ({ id, ...centreOwnership(rect, cx, cy) }))
    .sort(compareOwnership)
    .map((c) => c.id)
}

describe('centreOwnership', () => {
  it('marks the centre as inside a footprint that contains it', () => {
    const r: Rect = { left: 0, right: 100, top: 0, bottom: 100 }
    expect(centreOwnership(r, 50, 50).inside).toBe(true)
    expect(centreOwnership(r, 150, 50).inside).toBe(false)
  })

  it('keys an owner by how shallowly the centre sits below its top', () => {
    const r: Rect = { left: 0, right: 100, top: 20, bottom: 400 }
    expect(centreOwnership(r, 50, 60).key).toBe(40) // cy - top
  })

  it('keys a non-owner by squared distance to the footprint', () => {
    const r: Rect = { left: 0, right: 100, top: 0, bottom: 100 }
    // centre 30px to the right, level with the box → 30² = 900
    expect(centreOwnership(r, 130, 50).key).toBe(900)
  })
})

describe('compareOwnership ranking', () => {
  // The regression: a tall card stacked above bleeds its expanded footprint down over
  // the card whose band actually holds the centre. Both contain the centre, so a plain
  // "0 when inside" distance tied them and document order won. Ownership must pick the
  // card the centre natively sits in (the larger top above the centre).
  it('prefers the card whose band holds the centre over one bleeding down from above', () => {
    const above: Rect = { left: 0, right: 200, top: -300, bottom: 400 } // tall, from above
    const here: Rect = { left: 0, right: 200, top: 280, bottom: 700 } // band holds centre
    expect(rank({ above, here }, 100, 320)).toEqual(['here', 'above'])
    // ... and the document-order flip can't change the winner.
    expect(rank({ here, above }, 100, 320)).toEqual(['here', 'above'])
  })

  it('keeps a tall card you have scrolled into expanded when its body still owns the centre', () => {
    // Tall card whose top has scrolled above the viewport, neighbour entering from below.
    const scrolledInto: Rect = { left: 0, right: 200, top: -200, bottom: 600 }
    const entering: Rect = { left: 0, right: 200, top: 550, bottom: 900 }
    expect(rank({ scrolledInto, entering }, 100, 300)).toEqual(['scrolledInto', 'entering'])
  })

  it('falls back to nearest footprint when the centre sits over no card', () => {
    const near: Rect = { left: 0, right: 100, top: 0, bottom: 100 }
    const far: Rect = { left: 400, right: 500, top: 0, bottom: 100 }
    expect(rank({ far, near }, 150, 50)).toEqual(['near', 'far'])
  })
})
