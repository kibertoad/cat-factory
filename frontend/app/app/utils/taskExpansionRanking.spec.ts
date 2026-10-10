import { describe, it, expect } from 'vitest'
import { headerDistanceSq, type Rect } from './taskExpansionRanking'

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

describe('ordering by header distance', () => {
  // `useTaskExpansion` sorts candidates by this measure, so the card with the smaller value is
  // the one that expands. The regression from the screenshot: a tall card parked at the top of
  // the screen expands its pipeline down past the centre, so its body covers the centre. A
  // compact card whose header sits right at the centre must still win.
  it('prefers the card whose header is at the centre over a tall card bleeding down from the top', () => {
    const top: Rect = { left: 0, right: 200, top: 30, bottom: 700 } // header far up, body covers centre
    const here: Rect = { left: 0, right: 200, top: 320, bottom: 520 } // header at the centre
    expect(headerDistanceSq(here, 100, 340)).toBeLessThan(headerDistanceSq(top, 100, 340))
  })

  it('ranks by the header nearest the centre regardless of expansion state', () => {
    const above: Rect = { left: 0, right: 200, top: 100, bottom: 800 }
    const below: Rect = { left: 0, right: 200, top: 360, bottom: 420 }
    expect(headerDistanceSq(below, 100, 320)).toBeLessThan(headerDistanceSq(above, 100, 320))
  })

  it('uses horizontal offset to break a vertical tie', () => {
    const near: Rect = { left: 0, right: 100, top: 100, bottom: 200 }
    const far: Rect = { left: 400, right: 500, top: 100, bottom: 200 }
    expect(headerDistanceSq(near, 80, 100)).toBeLessThan(headerDistanceSq(far, 80, 100))
  })
})
