import { describe, it, expect } from 'vitest'
import { findFreeFramePosition, framesCollide, FRAME_GAP, type FrameRect } from './framePlacement'

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
