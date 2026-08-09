import type { Ref } from 'vue'

/**
 * One drawable link on the board's screen-space overlay: a border-to-border line between two
 * block cards. `done` rides only on dependency edges, where it picks the stroke and arrowhead.
 */
export type EdgeSegment = {
  id: string
  x1: number
  y1: number
  x2: number
  y2: number
  done?: boolean
}

/** Whether two resolved segment lists would draw exactly the same overlay. */
export function sameSegments(a: readonly EdgeSegment[], b: readonly EdgeSegment[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!
    const right = b[i]!
    if (
      left.id !== right.id ||
      left.x1 !== right.x1 ||
      left.y1 !== right.y1 ||
      left.x2 !== right.x2 ||
      left.y2 !== right.y2 ||
      left.done !== right.done
    ) {
      return false
    }
  }
  return true
}

/**
 * Publish a freshly measured list, and report whether it moved anything. Writing an
 * equal-but-new array every frame is what re-rendered the whole overlay 60 times a second on
 * a board where nothing was moving, and it is also the signal the settling frame loop reads
 * to decide it can park.
 *
 * The target is a `shallowRef`: the lists are replaced wholesale, so deep-proxying every
 * segment object would be pure overhead.
 */
export function commitSegments(target: Ref<EdgeSegment[]>, next: EdgeSegment[]): boolean {
  if (sameSegments(target.value, next)) return false
  target.value = next
  return true
}
