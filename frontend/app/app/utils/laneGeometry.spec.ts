import { describe, it, expect } from 'vitest'
import { frameContentSize, laneBodyHeightIn, LANE_GEOMETRY } from './laneGeometry'

/**
 * These pin the RELATION between the two derivations, not their pixel arithmetic. The numbers are
 * `LANE_GEOMETRY`'s to change; what must never change is that a frame sized by one of them hands
 * the other back exactly what it reserved, because that is the agreement three consumers depend on
 * (the frame's floor, what `FrameSwimlanes` renders into, and the spot placement reserves for a
 * frame that does not exist yet).
 */
describe('frameContentSize', () => {
  it('sizes a service with nothing in it to its "add the first task" panel, not to lanes', () => {
    // An empty service renders no lanes at all, so reserving lane-sized space for it would leave
    // the frame more than twice as tall as the one thing inside it — and push its neighbours that
    // much further away, since placement clears frames by their reserved footprint.
    const empty = frameContentSize({ hasChildren: false, initiatives: 0 })
    expect(empty).toEqual({
      w: LANE_GEOMETRY.emptyFrameWidth,
      h: LANE_GEOMETRY.emptyFrameHeight,
    })
    expect(empty.h).toBeLessThan(frameContentSize({ hasChildren: true, initiatives: 0 }).h)
  })

  it('does not grow with anything except the initiative band', () => {
    // The whole point of the lanes: a lane scrolls rather than growing, so nothing about a
    // service's task count reaches this function. Initiatives are the one child the frame still
    // lays out itself, so they are the one thing its height still answers to.
    const base = frameContentSize({ hasChildren: true, initiatives: 0 })
    expect(frameContentSize({ hasChildren: true, initiatives: 1 })).toEqual({
      w: base.w,
      h: base.h + LANE_GEOMETRY.initiativeHeight,
    })
    // A second row only once the first is full, whatever that width happens to allow.
    const perRow = Math.floor(LANE_GEOMETRY.canvasWidth / LANE_GEOMETRY.initiativeWidth)
    expect(frameContentSize({ hasChildren: true, initiatives: perRow }).h).toBe(
      base.h + LANE_GEOMETRY.initiativeHeight,
    )
    expect(frameContentSize({ hasChildren: true, initiatives: perRow + 1 }).h).toBe(
      base.h + 2 * LANE_GEOMETRY.initiativeHeight,
    )
  })
})

describe('laneBodyHeightIn', () => {
  it('hands a frame at its floor size exactly the lane body that floor was computed from', () => {
    // The round trip that keeps the lanes from being clipped by their own frame. Asserted for a
    // frame with an initiative band too, since the band is the term the two have to agree about.
    for (const initiatives of [0, 1, 5]) {
      const floor = frameContentSize({ hasChildren: true, initiatives })
      expect(laneBodyHeightIn(floor, initiatives)).toBe(LANE_GEOMETRY.laneBodyHeight)
    }
  })

  it('gives a dragged-taller frame the whole extra height', () => {
    // The contract `LANE_GEOMETRY` states and `containerSize` implements: the geometry is a FLOOR,
    // and a reader who wants more room drags the border. The lanes kept a constant height before
    // this, so the extra space was dead canvas below them and the gesture appeared to do nothing.
    const floor = frameContentSize({ hasChildren: true, initiatives: 0 })
    const dragged = { w: floor.w, h: floor.h + 300 }
    expect(laneBodyHeightIn(dragged, 0)).toBe(LANE_GEOMETRY.laneBodyHeight + 300)
  })

  it('never returns less than the floor lane body, whatever it is handed', () => {
    // A frame cannot be dragged below its floor, so this is only reachable by a caller measuring
    // one mid-layout; collapsing a lane to nothing (or a negative height) is never the answer.
    expect(laneBodyHeightIn({ w: 100, h: 0 }, 0)).toBe(LANE_GEOMETRY.laneBodyHeight)
    expect(laneBodyHeightIn({ w: 100, h: 40 }, 12)).toBe(LANE_GEOMETRY.laneBodyHeight)
  })
})
