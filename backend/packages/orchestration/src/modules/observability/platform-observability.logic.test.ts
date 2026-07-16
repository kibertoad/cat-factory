import { describe, expect, it } from 'vitest'
import type { PlatformMetricsRepository } from '@cat-factory/kernel'
import { PlatformObservabilityService } from './PlatformObservabilityService.js'
import { PLATFORM_WINDOWS, buildTrend, summarizeOutcomes } from './platform-observability.logic.js'

describe('summarizeOutcomes', () => {
  it('folds status rows into totals + success rate', () => {
    const totals = summarizeOutcomes([
      { kind: 'execution', status: 'done', count: 6 },
      { kind: 'bootstrap', status: 'done', count: 2 },
      { kind: 'execution', status: 'failed', count: 2 },
      { kind: 'execution', status: 'running', count: 3 },
      { kind: 'execution', status: 'blocked', count: 1 },
      { kind: 'execution', status: 'paused', count: 1 },
      { kind: 'bootstrap', status: 'pending', count: 4 },
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
    const totals = summarizeOutcomes([{ kind: 'execution', status: 'running', count: 3 }])
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
    durationStatsSince: async () => ({ count: 4, avgMs: 2000, minMs: 1000, maxMs: 3000 }),
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
    expect(view.durations).toEqual({ count: 4, avgMs: 2000, minMs: 1000, maxMs: 3000 })
    // The trend is contiguous and zero-filled across all 24 hourly buckets.
    expect(view.trend.points.length).toBeGreaterThanOrEqual(24)
  })
})
