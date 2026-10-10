import { describe, expect, it } from 'vitest'
import type { ReportSpendRow } from '@cat-factory/contracts'
import type { ReportSpendTrendBucket } from '@cat-factory/kernel'
import {
  REPORT_WINDOWS,
  alignWindowStart,
  buildSpendTrend,
  capSlices,
  foldTotals,
  toSpendRow,
} from './reports.logic.js'

const spendRow = (key: string, meteredCost: number): ReportSpendRow => ({
  key,
  label: null,
  inputTokens: 1,
  outputTokens: 1,
  calls: 1,
  meteredCost,
  subscriptionCost: 0,
})

const bucket = (over: Partial<ReportSpendTrendBucket>): ReportSpendTrendBucket => ({
  bucketStart: 0,
  meteredCost: 0,
  subscriptionCost: 0,
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  ...over,
})

describe('reports logic', () => {
  it('sizes every window into a bucket count a chart can render', () => {
    for (const [name, { windowMs, bucketMs }] of Object.entries(REPORT_WINDOWS)) {
      const buckets = windowMs / bucketMs
      expect(Number.isInteger(buckets), `${name} divides evenly`).toBe(true)
      expect(buckets, `${name} bucket count`).toBeGreaterThanOrEqual(24)
      expect(buckets, `${name} bucket count`).toBeLessThanOrEqual(48)
    }
  })

  it('snaps the window start onto a bucket edge so the first column is complete', () => {
    // A request arriving 900ms into a 1000ms bucket would otherwise chart a 100ms sliver at
    // the same width as a full bucket, which reads as a quiet period rather than a partial one.
    expect(alignWindowStart(10_900, 9_000, 1_000)).toBe(1_000)
    // Already on an edge ⇒ unchanged, so the common case is not silently widened.
    expect(alignWindowStart(10_000, 9_000, 1_000)).toBe(1_000)
    // Snapping only ever moves the start EARLIER: a window never loses data to alignment.
    for (const { windowMs, bucketMs } of Object.values(REPORT_WINDOWS)) {
      const until = 1_800_000_123_456
      const since = alignWindowStart(until, windowMs, bucketMs)
      expect(since).toBeLessThanOrEqual(until - windowMs)
      expect(until - windowMs - since).toBeLessThan(bucketMs)
      expect(since % bucketMs).toBe(0)
    }
  })

  it('folds totals across every slice of a breakdown', () => {
    const totals = foldTotals(
      [
        {
          key: 'anthropic:claude',
          label: null,
          inputTokens: 10,
          outputTokens: 4,
          calls: 2,
          meteredCost: 1.5,
          subscriptionCost: 0,
        },
        {
          key: '',
          label: null,
          inputTokens: 3,
          outputTokens: 1,
          calls: 1,
          meteredCost: 0,
          subscriptionCost: 0.25,
        },
      ].map(toSpendRow),
    )
    expect(totals).toEqual({
      inputTokens: 13,
      outputTokens: 5,
      calls: 3,
      meteredCost: 1.5,
      subscriptionCost: 0.25,
    })
  })

  it('keeps the metered and subscription costs apart in the fold', () => {
    // Only `meteredCost` is real money; a fold that collapsed the two would report
    // flat-rate quota usage as spend.
    const totals = foldTotals([
      toSpendRow({
        key: 'claude-code:sonnet',
        label: null,
        inputTokens: 0,
        outputTokens: 0,
        calls: 1,
        meteredCost: 0,
        subscriptionCost: 12,
      }),
    ])
    expect(totals.meteredCost).toBe(0)
    expect(totals.subscriptionCost).toBe(12)
  })

  it('zero-fills the trend across the whole window, oldest first', () => {
    const points = buildSpendTrend([bucket({ bucketStart: 2_000, calls: 3 })], 1_000, 4_000, 1_000)
    expect(points.map((p) => p.start)).toEqual([1_000, 2_000, 3_000, 4_000])
    expect(points.map((p) => p.calls)).toEqual([0, 3, 0, 0])
  })

  it('keeps a bucket that falls outside the zero-filled span', () => {
    // A row stamped ahead of `until` (clock skew across nodes) is still spend that
    // happened; dropping it would silently under-report the window.
    const points = buildSpendTrend(
      [bucket({ bucketStart: 9_000, meteredCost: 5 })],
      1_000,
      2_000,
      1_000,
    )
    expect(points.map((p) => p.start)).toEqual([1_000, 2_000, 9_000])
    expect(points.at(-1)?.meteredCost).toBe(5)
  })

  it('sums several buckets that land on the same slice', () => {
    const points = buildSpendTrend(
      [
        bucket({ bucketStart: 1_000, meteredCost: 1, inputTokens: 5 }),
        bucket({ bucketStart: 1_000, meteredCost: 2, inputTokens: 7 }),
      ],
      1_000,
      1_000,
      1_000,
    )
    expect(points).toHaveLength(1)
    expect(points[0]).toMatchObject({ start: 1_000, meteredCost: 3, inputTokens: 12 })
  })

  it('leaves a breakdown that fits under the limit untouched and uncapped', () => {
    // The `cap` is null rather than a zero-omission record, so an empty `capped` list on the
    // projection means every breakdown in it is complete.
    const rows = [spendRow('a', 3), spendRow('b', 2)]
    const capped = capSlices('run', rows, 2)
    expect(capped.rows).toEqual(rows)
    expect(capped.cap).toBeNull()
  })

  it('keeps the heaviest slices and reports exactly how many it dropped', () => {
    const rows = [spendRow('a', 5), spendRow('b', 4), spendRow('c', 3), spendRow('d', 2)]
    const capped = capSlices('ticket', rows, 2)
    expect(capped.rows.map((r) => r.key)).toEqual(['a', 'b'])
    expect(capped.cap).toEqual({ dimension: 'ticket', returned: 2, omitted: 2 })
  })

  it('folds totals over the UNCAPPED rows, so a cap never costs the window its money', () => {
    // The invariant the cap rests on: what a reader loses is the identity of the tail, and
    // the totals still account for it. Folding after the cap would under-report the window
    // while the projection still read as complete.
    const rows = [spendRow('a', 5), spendRow('b', 4), spendRow('c', 3)]
    const capped = capSlices('run', rows, 1)
    expect(foldTotals(rows).meteredCost).toBe(12)
    expect(foldTotals(capped.rows).meteredCost).toBe(5)
  })
})
