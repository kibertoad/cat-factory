import { describe, expect, it } from 'vitest'
import { columnPct, segmentShares } from './TrendColumn.logic'

describe('TrendColumn sizing', () => {
  it('scales a column against the tallest and draws nothing without a max', () => {
    expect(columnPct(500, 1000, 2)).toBe(50)
    expect(columnPct(0, 1000, 2)).toBe(0)
    expect(columnPct(5, 0, 2)).toBe(0)
  })

  it('floors a non-zero column so a small bucket stays visible', () => {
    // Without the floor a single cheap call rounds to an empty column and reads as a
    // quiet period, which is the opposite of what happened.
    expect(columnPct(0.001, 1000, 2)).toBe(2)
  })

  it('floors the column total once, so a stack of small segments keeps its rank', () => {
    // Flooring each segment drew failed=1, other=1, done=1 at 12% and done=10 at 10%.
    expect(columnPct(3, 100, 4)).toBeLessThan(columnPct(10, 100, 4))
    // And the busiest column draws at the full height, not past it.
    expect(columnPct(100, 100, 4)).toBe(100)
  })

  it('splits a column by share and leaves out zero segments', () => {
    const shares = segmentShares([
      { value: 1, class: 'a' },
      { value: 0, class: 'b' },
      { value: 3, class: 'c' },
    ])
    expect(shares.map((s) => [s.class, s.sharePct])).toEqual([
      ['a', 25],
      ['c', 75],
    ])
    expect(segmentShares([{ value: 0, class: 'a' }])).toEqual([])
  })
})
