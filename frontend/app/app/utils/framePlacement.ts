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
import { frameContentSize } from '~/utils/laneGeometry'

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
 * Footprint of a freshly-added, empty service frame in flow-space.
 *
 * DERIVED from the lane geometry rather than restated, because a placement decision is made
 * BEFORE the block exists and so cannot measure it: the numbers here and the ones the frame
 * renders at have to be the same numbers, or a new service is dropped on top of a neighbour it
 * was placed to clear. A hand-copied pair went stale exactly that way when the frame's floor
 * changed underneath it.
 */
export const EMPTY_FRAME_SIZE = frameContentSize({ hasChildren: false, initiatives: 0 })

/**
 * Footprint of an epic grouping node in flow-space. Epics are top-level board nodes
 * drawn alongside frames (see `BoardCanvas`), so a placed frame must clear them too.
 * Mirrors the compact `EpicNode` card (`w-56` = 224px, ~96px tall); a slight
 * over-estimate is harmless — it only widens the clearance around an epic.
 */
export const EPIC_NODE_SIZE = { w: 224, h: 96 }

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

/** A rect on the board that knows which block it belongs to. */
export interface PlacedRect extends FrameRect {
  readonly id: string
}

/**
 * How many times one rect may be pushed off a neighbour before we stop nudging and fall back to
 * the ring search. Each push clears the rect it hit but can walk it into a third one, so a dense
 * cluster needs several; a cluster that needs more than this is one the incremental nudge is not
 * going to untangle, and {@link findFreeFramePosition} always answers.
 */
const MAX_SEPARATION_PUSHES = 8

/**
 * The nearest place `moving` can sit that clears `settled` by `gap`: the minimum translation
 * along whichever axis it is cheapest to leave by, which is what makes a frame nudged onto a
 * neighbour bounce off the nearest border rather than teleport around it.
 *
 * Each candidate edge is rounded OUTWARD, away from the rect being cleared. A drag divides the
 * pointer delta by the board zoom, so the positions coming in here are routinely fractional, and
 * rounding the other way would leave a sub-pixel of the overlap behind for the next pass to find
 * and shave again.
 *
 * Ties are broken in a fixed order (right before left, horizontal before vertical) rather than by
 * anything read off the board, because every client resolves the same overlap independently and
 * two of them answering differently would have the frames trade places on every refresh. A tie
 * only arises when the two rects are exactly concentric on that axis.
 */
function separatedPosition(moving: FrameRect, settled: FrameRect, gap: number): Point {
  const right = Math.ceil(settled.x + settled.w + gap)
  const left = Math.floor(settled.x - gap - moving.w)
  const down = Math.ceil(settled.y + settled.h + gap)
  const up = Math.floor(settled.y - gap - moving.h)
  const x = Math.abs(right - moving.x) <= Math.abs(left - moving.x) ? right : left
  const y = Math.abs(down - moving.y) <= Math.abs(up - moving.y) ? down : up
  return Math.abs(x - moving.x) <= Math.abs(y - moving.y) ? { x, y: moving.y } : { x: moving.x, y }
}

/**
 * Order the rects for settlement: the `anchorIds` in the order given, then everything else in
 * reading order (top row first, then left to right), with the id as the final tie-break.
 *
 * The order IS the policy. A rect settles into the space the ones before it have already taken,
 * so whatever comes first keeps its exact position and later ones bounce off it: naming the frame
 * the user is dragging (or that just grew) as the first anchor is what makes a deliberate drop
 * land where it was aimed while its neighbours move aside, instead of the other way round.
 */
function bySettlementOrder(anchorIds: readonly string[]) {
  const rank = new Map<string, number>()
  anchorIds.forEach((id, i) => {
    if (!rank.has(id)) rank.set(id, i)
  })
  const priority = (r: PlacedRect) => rank.get(r.id) ?? Number.MAX_SAFE_INTEGER
  return (a: PlacedRect, b: PlacedRect): number =>
    priority(a) - priority(b) || a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/**
 * Push apart every board node that overlaps another, returning the new top-left of each one that
 * had to move (and nothing for the ones that did not, so an already-clear board answers empty).
 *
 * This is the board's standing layout invariant, not a placement decision: a frame can come to
 * overlap a neighbour long after it was placed, by being dragged onto it, by a border drag, or by
 * growing when its first task arrives (an empty service reserves a much smaller footprint than
 * one rendering lanes). All three land here, so the rule is stated once rather than at each of
 * the writes that can break it.
 *
 * The result is a pure function of the rects and the anchor order, so every client watching the
 * same board computes the same answer and their corrections converge instead of fighting.
 */
export function resolveFrameOverlaps(
  rects: readonly PlacedRect[],
  opts?: { anchorIds?: readonly string[]; gap?: number },
): Map<string, Point> {
  const gap = opts?.gap ?? FRAME_GAP
  const settled: FrameRect[] = []
  const moved = new Map<string, Point>()
  for (const rect of [...rects].sort(bySettlementOrder(opts?.anchorIds ?? []))) {
    let at: FrameRect = { ...rect }
    for (let push = 0; push < MAX_SEPARATION_PUSHES; push++) {
      const blocker = settled.find((s) => framesCollide(at, s, gap))
      if (!blocker) break
      at = { ...at, ...separatedPosition(at, blocker, gap) }
    }
    if (!fits(at, settled, gap)) {
      const free = findFreeFramePosition(settled, rect, { x: rect.x, y: rect.y }, gap)
      at = { ...rect, x: free.x, y: free.y }
    }
    settled.push(at)
    if (at.x !== rect.x || at.y !== rect.y) moved.set(rect.id, { x: at.x, y: at.y })
  }
  return moved
}

/**
 * Which of `next`'s rects moved or changed size since `previous`: the frames whose new geometry
 * is the CAUSE of any overlap it created, and so the ones {@link resolveFrameOverlaps} should
 * anchor rather than shove back.
 *
 * A rect absent from `previous` is deliberately NOT reported: a frame arriving on the board (a
 * newly mounted shared service, another client's creation, the first pass over a freshly hydrated
 * board) has no established place to defend, so it yields to the frames already there.
 */
export function changedRectIds(
  previous: ReadonlyMap<string, FrameRect>,
  next: readonly PlacedRect[],
): string[] {
  return next
    .filter((r) => {
      const was = previous.get(r.id)
      return was !== undefined && (was.x !== r.x || was.y !== r.y || was.w !== r.w || was.h !== r.h)
    })
    .map((r) => r.id)
}
