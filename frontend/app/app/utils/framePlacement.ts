/**
 * Pure geometry for placing a new service frame on the board without overlapping
 * the ones already there. Split out from the composable that reads the live board
 * so the placement decision is a plain, deterministically testable function.
 *
 * Everything here is flow-space (the absolute `{ x, y }` a block stores), with the
 * origin at a frame's top-left corner — the same coordinate system Vue Flow renders
 * nodes in. Sizes are the frame's rendered pixel footprint (see
 * {@link useBlockQueries.containerSize}).
 */

export interface Point {
  x: number
  y: number
}

export interface FrameRect extends Point {
  w: number
  h: number
}

/** Spacing kept between frames so a placed frame never sits flush against a neighbour. */
export const FRAME_GAP = 48

/**
 * Footprint of a freshly-added, empty service frame in flow-space. Mirrors the
 * empty-frame floor in {@link useBlockQueries.contentSize} (w 360, inner h 220) so a
 * placement decision made BEFORE the block exists matches how it will actually render.
 */
export const EMPTY_FRAME_SIZE = { w: 360, h: 220 }

/**
 * Do rects `a` and `b` come within `gap` px of each other — i.e. fail to clear? Two
 * rects clear when a full `gap`-wide channel separates them on any axis; if none does,
 * they collide.
 */
export function framesCollide(a: FrameRect, b: FrameRect, gap = 0): boolean {
  return !(
    a.x + a.w + gap <= b.x ||
    b.x + b.w + gap <= a.x ||
    a.y + a.h + gap <= b.y ||
    b.y + b.h + gap <= a.y
  )
}

function fits(candidate: FrameRect, existing: FrameRect[], gap: number): boolean {
  return existing.every((r) => !framesCollide(candidate, r, gap))
}

function dist2(a: Point, b: Point): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

/**
 * Find a top-left position for a new frame of `size` that clears every rect in
 * `existing` by at least `gap`, staying as close as possible to `desired`.
 *
 * `desired` is used verbatim when it's already free, so a deliberate drop lands where
 * the user aimed. Otherwise we spiral outward on a grid of frame-sized steps and take
 * the nearest free cell. The ring search is bounded, so as a guaranteed last resort we
 * drop the frame in a fresh column to the right of everything — a board can't have a
 * position that never clears.
 */
export function findFreeFramePosition(
  existing: FrameRect[],
  size: { w: number; h: number },
  desired: Point,
  gap = FRAME_GAP,
): Point {
  const rectAt = (p: Point): FrameRect => ({ x: p.x, y: p.y, w: size.w, h: size.h })
  if (fits(rectAt(desired), existing, gap)) return desired

  const stepX = size.w + gap
  const stepY = size.h + gap
  const MAX_RADIUS = 12
  for (let radius = 1; radius <= MAX_RADIUS; radius++) {
    // The candidates on this square ring, nearest-to-`desired` first, so the chosen
    // free cell is the closest one at this radius (a ring is scanned whole before we
    // widen, so overall we still take the nearest free cell on the board).
    const ring: Point[] = []
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue
        ring.push({ x: desired.x + dx * stepX, y: desired.y + dy * stepY })
      }
    }
    ring.sort((p, q) => dist2(p, desired) - dist2(q, desired))
    for (const c of ring) if (fits(rectAt(c), existing, gap)) return c
  }

  const rightmost = existing.reduce((m, r) => Math.max(m, r.x + r.w), desired.x)
  return { x: rightmost + gap, y: desired.y }
}
