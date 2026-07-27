import { describe, expect, it } from 'vitest'
import type { ReportActivityRow, ReportSpendRow } from '~/types/execution'
import {
  activitySegments,
  columnPct,
  isUnattributed,
  maxOf,
  segmentPct,
  spendMagnitude,
} from './ReportsPanel.logic'

const spend = (over: Partial<ReportSpendRow>): ReportSpendRow => ({
  key: 'k',
  label: null,
  inputTokens: 0,
  outputTokens: 0,
  calls: 0,
  meteredCost: 0,
  subscriptionCost: 0,
  ...over,
})

describe('ReportsPanel logic', () => {
  it('ranks a spend slice by its combined footprint', () => {
    // Ranking/scaling only: the sum mixes real money with the illustrative cost of
    // flat-rate quota usage, so no caller may render it as an amount. `ReportsSpendBreakdown`
    // shows `meteredCost` and `subscriptionCost` as separate figures for exactly that reason.
    expect(spendMagnitude(spend({ meteredCost: 2, subscriptionCost: 3 }))).toBe(5)
  })

  it('scales every segment against the widest row, not its own row', () => {
    // A per-row denominator would draw both bars full-width and erase the ranking.
    const rows = [spend({ meteredCost: 10 }), spend({ meteredCost: 2 })]
    const max = maxOf(rows, spendMagnitude)
    expect(segmentPct(rows[0]!.meteredCost, max)).toBe(100)
    expect(segmentPct(rows[1]!.meteredCost, max)).toBe(20)
  })

  it('returns a zero max for an empty list and draws nothing from it', () => {
    expect(maxOf([], spendMagnitude)).toBe(0)
    expect(segmentPct(5, 0)).toBe(0)
    expect(columnPct(5, 0)).toBe(0)
  })

  it('floors a non-zero column so a small bucket stays visible', () => {
    // Without the floor a single cheap call rounds to an empty column and reads as a
    // quiet period, which is the opposite of what happened.
    expect(columnPct(0.001, 1000)).toBe(2)
    expect(columnPct(0, 1000)).toBe(0)
    expect(columnPct(500, 1000)).toBe(50)
  })

  it('treats the empty key as the unattributed bucket', () => {
    expect(isUnattributed('')).toBe(true)
    expect(isUnattributed('feature')).toBe(false)
  })

  it('lists activity status splits in the legend order', () => {
    const row: ReportActivityRow = {
      key: 'ws',
      label: 'Board',
      runs: 6,
      done: 3,
      failed: 2,
      running: 1,
      other: 0,
      avgDurationMs: 100,
    }
    expect(activitySegments(row)).toEqual([
      { status: 'done', count: 3 },
      { status: 'failed', count: 2 },
      { status: 'running', count: 1 },
      { status: 'other', count: 0 },
    ])
  })
})
