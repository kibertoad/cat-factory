import { describe, expect, it } from 'vitest'
import type { PlatformMetricsRepository } from '@cat-factory/kernel'
import { PlatformObservabilityService } from './PlatformObservabilityService.js'
import {
  DAY_MS,
  PLATFORM_WINDOWS,
  buildTrend,
  dailyFailureSlices,
  summarizeGateOutcomes,
  summarizeOutcomes,
} from './platform-observability.logic.js'

describe('summarizeOutcomes', () => {
  it('folds status rows into totals + success rate', () => {
    const totals = summarizeOutcomes([
      { status: 'done', count: 6 },
      { status: 'done', count: 2 },
      { status: 'failed', count: 2 },
      { status: 'running', count: 3 },
      { status: 'blocked', count: 1 },
      { status: 'paused', count: 1 },
      { status: 'pending', count: 4 },
    ])
    expect(totals.total).toBe(19)
    expect(totals.done).toBe(8)
    expect(totals.failed).toBe(2)
    expect(totals.running).toBe(3)
    expect(totals.blocked).toBe(1)
    expect(totals.paused).toBe(1)
    expect(totals.other).toBe(4) // pending
    expect(totals.successRate).toBeCloseTo(8 / 10)
  })

  it('reports a null success rate when no run reached a terminal outcome', () => {
    const totals = summarizeOutcomes([{ status: 'running', count: 3 }])
    expect(totals.successRate).toBeNull()
    expect(totals.total).toBe(3)
  })
})

describe('buildTrend', () => {
  it('zero-fills a contiguous, oldest-first series across the window', () => {
    // Window [0, 3000] at 1000ms buckets → buckets 0, 1000, 2000, 3000.
    const points = buildTrend(
      [
        { bucketStart: 0, status: 'done', count: 2 },
        { bucketStart: 2000, status: 'failed', count: 1 },
        { bucketStart: 2000, status: 'running', count: 3 },
      ],
      0,
      3000,
      1000,
    )
    expect(points.map((p) => p.start)).toEqual([0, 1000, 2000, 3000])
    expect(points[0]).toEqual({ start: 0, done: 2, failed: 0, other: 0 })
    expect(points[1]).toEqual({ start: 1000, done: 0, failed: 0, other: 0 })
    expect(points[2]).toEqual({ start: 2000, done: 0, failed: 1, other: 3 })
    expect(points[3]).toEqual({ start: 3000, done: 0, failed: 0, other: 0 })
  })
})

describe('PlatformObservabilityService', () => {
  const repo = (): PlatformMetricsRepository => ({
    runOutcomesSince: async () => [
      { kind: 'execution', status: 'done', count: 3 },
      { kind: 'execution', status: 'failed', count: 1 },
    ],
    runOutcomeTrend: async () => [{ bucketStart: 0, status: 'done', count: 3 }],
    failureKindBreakdown: async () => [{ failureKind: 'agent', count: 1 }],
    activeAndParkedCounts: async () => ({ running: 1, blocked: 0, paused: 0, pending: 2 }),
    durationStatsSince: async () => ({
      count: 4,
      avgMs: 2000,
      minMs: 1000,
      maxMs: 3000,
      p50Ms: 2000,
      p90Ms: 3000,
      p99Ms: 3000,
    }),
    rollupRunDays: async () => 0,
    dailyRunTotalsSince: async () => [
      { dayStart: 0, status: 'done', failureKind: null, count: 5 },
      { dayStart: 0, status: 'failed', failureKind: 'evicted', count: 2 },
      { dayStart: DAY_MS, status: 'failed', failureKind: 'agent', count: 1 },
    ],
    dailyRollupWatermark: async () => DAY_MS,
    deleteRunDaysOlderThan: async () => 0,
    recentFailedRuns: async () => [],
  })

  it('composes the windowed projection from the rollups', async () => {
    const now = 24 * 60 * 60_000 * 3 // a fixed "now" well past the 24h window
    const service = new PlatformObservabilityService({
      platformMetricsRepository: repo(),
      clock: { now: () => now },
    })
    const view = await service.summarize('acc-1', '24h')
    expect(view.window).toBe('24h')
    expect(view.generatedAt).toBe(now)
    expect(view.since).toBe(now - PLATFORM_WINDOWS['24h'].windowMs)
    expect(view.trend.bucketMs).toBe(PLATFORM_WINDOWS['24h'].bucketMs)
    expect(view.outcomes.done).toBe(3)
    expect(view.outcomes.successRate).toBeCloseTo(0.75)
    expect(view.failures).toEqual([{ kind: 'agent', count: 1 }])
    expect(view.live).toEqual({ running: 1, blocked: 0, paused: 0, pending: 2 })
    expect(view.durations).toEqual({
      count: 4,
      avgMs: 2000,
      minMs: 1000,
      maxMs: 3000,
      p50Ms: 2000,
      p90Ms: 3000,
      p99Ms: 3000,
    })
    // The trend is contiguous and zero-filled across all 24 hourly buckets.
    expect(view.trend.points.length).toBeGreaterThanOrEqual(24)
    // A live-scanned window states its source and reports no rollup watermark: there is no
    // rollup in the path, so there is nothing about it that could be behind.
    expect(view.source).toBe('runs')
    expect(view.rolledUpThrough).toBeNull()
  })

  it('serves a long window from the daily rollup and reports how far it reaches', async () => {
    const now = 100 * DAY_MS
    const service = new PlatformObservabilityService({
      platformMetricsRepository: repo(),
      clock: { now: () => now },
    })
    const view = await service.summarize('acc-1', '30d')
    expect(view.source).toBe('daily-rollup')
    // The watermark is a fact about the SWEEP, not about the runs: a reader can see the rollup
    // stops ~99 days short of `now` rather than reading the empty tail as an idle month.
    expect(view.rolledUpThrough).toBe(DAY_MS)
    expect(view.trend.bucketMs).toBe(DAY_MS)
    // Totals AND the failure taxonomy both fold from the one rollup read.
    expect(view.outcomes.done).toBe(5)
    expect(view.outcomes.failed).toBe(3)
    expect(view.failures).toEqual([
      { kind: 'evicted', count: 2 },
      { kind: 'agent', count: 1 },
    ])
  })
})

describe('dailyFailureSlices', () => {
  it('sums failure kinds across days, most frequent first, and ignores non-failed rows', () => {
    const slices = dailyFailureSlices([
      { dayStart: 0, status: 'done', failureKind: null, count: 40 },
      { dayStart: 0, status: 'failed', failureKind: 'agent', count: 1 },
      { dayStart: DAY_MS, status: 'failed', failureKind: 'agent', count: 2 },
      { dayStart: DAY_MS, status: 'failed', failureKind: 'evicted', count: 2 },
    ])
    expect(slices).toEqual([
      { kind: 'agent', count: 3 },
      { kind: 'evicted', count: 2 },
    ])
  })

  it('counts a failed row with no recorded kind as `unknown` rather than dropping it', () => {
    // Dropping it would leave the slice totals silently short of the window's failure count.
    expect(
      dailyFailureSlices([{ dayStart: 0, status: 'failed', failureKind: null, count: 3 }]),
    ).toEqual([{ kind: 'unknown', count: 3 }])
  })
})

describe('summarizeGateOutcomes', () => {
  it('folds the per-outcome buckets into one row per gate kind, busiest first', () => {
    const stats = summarizeGateOutcomes([
      {
        gateKind: 'ci',
        helperKind: 'ci-fixer',
        outcome: 'passed',
        gates: 10,
        attempts: 7,
        helperFailures: 1,
        cleanGates: 6,
      },
      {
        gateKind: 'ci',
        helperKind: 'ci-fixer',
        outcome: 'exhausted',
        gates: 2,
        attempts: 6,
        helperFailures: 2,
        cleanGates: 0,
      },
      {
        gateKind: 'conflicts',
        helperKind: 'conflict-resolver',
        outcome: 'passed',
        gates: 4,
        attempts: 0,
        helperFailures: 0,
        cleanGates: 4,
      },
    ])
    expect(stats.map((s) => s.gateKind)).toEqual(['ci', 'conflicts'])
    expect(stats[0]).toEqual({
      gateKind: 'ci',
      helperKind: 'ci-fixer',
      gates: 12,
      passed: 10,
      exhausted: 2,
      // Only the PASSED bucket contributes clean passes: an exhausted gate by definition spent
      // attempts, and counting its `cleanGates` would claim gates that passed on the precheck.
      cleanPasses: 6,
      attempts: 13,
      helperFailures: 3,
    })
  })

  it('keeps the helper label when a gate only ever passed cleanly in the window', () => {
    // A gate that never escalated records no helper on its rows, but the label is a property of
    // the gate definition and blanking it would read as "this gate has no fixer".
    const stats = summarizeGateOutcomes([
      {
        gateKind: 'ci',
        helperKind: null,
        outcome: 'passed',
        gates: 3,
        attempts: 0,
        helperFailures: 0,
        cleanGates: 3,
      },
      {
        gateKind: 'ci',
        helperKind: 'ci-fixer',
        outcome: 'passed',
        gates: 1,
        attempts: 2,
        helperFailures: 0,
        cleanGates: 0,
      },
    ])
    expect(stats[0]?.helperKind).toBe('ci-fixer')
  })
})
