import { describe, it, expect } from 'vitest'
import { headerDistanceSq, type Rect } from './taskExpansionRanking'

/** Rank a set of cards against a screen centre, best (would-expand) first. */
function rank(cards: Record<string, Rect>, cx: number, cy: number): string[] {
  return Object.entries(cards)
    .map(([id, rect]) => ({ id, dist: headerDistanceSq(rect, cx, cy) }))
    .sort((a, b) => a.dist - b.dist)
    .map((c) => c.id)
}

describe('headerDistanceSq', () => {
  it('measures from the centre of the card top edge', () => {
    const r: Rect = { left: 0, right: 100, top: 200, bottom: 600 }
    // top-centre is (50, 200); centre (50, 240) → dy 40 → 40² = 1600
    expect(headerDistanceSq(r, 50, 240)).toBe(1600)
    // 30px to the right of the top-centre, level with the top → 30² = 900
    expect(headerDistanceSq(r, 80, 200)).toBe(900)
  })

  it('ignores the expanded height — only the top edge counts', () => {
    const short: Rect = { left: 0, right: 100, top: 200, bottom: 260 }
    const tall: Rect = { left: 0, right: 100, top: 200, bottom: 2000 }
    expect(headerDistanceSq(short, 50, 240)).toBe(headerDistanceSq(tall, 50, 240))
  })
})

describe('ranking', () => {
  // The regression from the screenshot: a tall card parked at the top of the screen
  // expands its pipeline down past the centre, so its body covers the centre. A compact
  // card whose header sits right at the centre must still win — the one you're looking at.
  it('prefers the card whose header is at the centre over a tall card bleeding down from the top', () => {
    const top: Rect = { left: 0, right: 200, top: 30, bottom: 700 } // header far up, body covers centre
    const here: Rect = { left: 0, right: 200, top: 320, bottom: 520 } // header at the centre
    expect(rank({ top, here }, 100, 340)).toEqual(['here', 'top'])
    // document order can't flip the winner
    expect(rank({ here, top }, 100, 340)).toEqual(['here', 'top'])
  })

  it('ranks by the header nearest the centre regardless of expansion state', () => {
    const above: Rect = { left: 0, right: 200, top: 100, bottom: 800 }
    const below: Rect = { left: 0, right: 200, top: 360, bottom: 420 }
    expect(rank({ above, below }, 100, 320)).toEqual(['below', 'above'])
  })

  it('uses horizontal offset to break a vertical tie', () => {
    const near: Rect = { left: 0, right: 100, top: 100, bottom: 200 }
    const far: Rect = { left: 400, right: 500, top: 100, bottom: 200 }
    expect(rank({ far, near }, 80, 100)).toEqual(['near', 'far'])
  })
})
