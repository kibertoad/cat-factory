import { describe, it, expect } from 'vitest'
import { shallowRef } from 'vue'
import { commitSegments, sameSegments, type EdgeSegment } from './edgeSegments'

const line = (over: Partial<EdgeSegment> = {}): EdgeSegment => ({
  id: 'a__b',
  x1: 0,
  y1: 0,
  x2: 10,
  y2: 10,
  ...over,
})

describe('sameSegments', () => {
  it('accepts a freshly measured list that resolved to the same overlay', () => {
    expect(sameSegments([line()], [line()])).toBe(true)
  })

  it('rejects a moved endpoint, however slightly', () => {
    expect(sameSegments([line()], [line({ y2: 10.5 })])).toBe(false)
  })

  it('rejects a changed link set', () => {
    expect(sameSegments([line()], [])).toBe(false)
    expect(sameSegments([line()], [line({ id: 'a__c' })])).toBe(false)
  })

  it('rejects a dependency whose source finished, since it restyles the arrow', () => {
    expect(sameSegments([line({ done: false })], [line({ done: true })])).toBe(false)
  })
})

describe('commitSegments', () => {
  it('publishes a changed list and reports it', () => {
    const target = shallowRef<EdgeSegment[]>([line()])
    const next = [line({ x2: 20 })]
    expect(commitSegments(target, next)).toBe(true)
    expect(target.value).toBe(next)
  })

  it('leaves the published array untouched when nothing moved', () => {
    const published = [line()]
    const target = shallowRef<EdgeSegment[]>(published)
    // Identity has to survive, not just the values: reassigning an equal-but-new array is
    // what re-rendered the whole overlay on every frame of an idle board.
    expect(commitSegments(target, [line()])).toBe(false)
    expect(target.value).toBe(published)
  })
})
