import { describe, expect, it } from 'vitest'
import type { PlatformObservability } from '@cat-factory/contracts'
import {
  DEFAULT_PLATFORM_ALERT_THRESHOLDS,
  evaluatePlatformHealth,
  platformAlertReasons,
  platformHealthCardContent,
} from './platform-health.logic.js'

// A healthy baseline projection; each test overrides only the field it exercises.
function snapshot(over: {
  outcomes?: Partial<PlatformObservability['outcomes']>
  durations?: Partial<PlatformObservability['durations']>
  live?: Partial<PlatformObservability['live']>
}): PlatformObservability {
  return {
    window: '1h',
    generatedAt: 1_000,
    since: 0,
    outcomes: {
      total: 20,
      done: 20,
      failed: 0,
      running: 0,
      blocked: 0,
      paused: 0,
      other: 0,
      successRate: 1,
      ...over.outcomes,
    },
    trend: { bucketMs: 300_000, points: [] },
    failures: [],
    live: { running: 0, blocked: 0, paused: 0, pending: 0, ...over.live },
    durations: {
      count: 20,
      avgMs: 1_000,
      minMs: 500,
      maxMs: 2_000,
      p50Ms: 1_000,
      p90Ms: 1_500,
      p99Ms: 1_800,
      ...over.durations,
    },
  }
}

const T = DEFAULT_PLATFORM_ALERT_THRESHOLDS

describe('evaluatePlatformHealth', () => {
  it('is quiet on a healthy deployment', () => {
    expect(evaluatePlatformHealth(snapshot({}), T)).toEqual([])
  })

  it('fires failure_rate_high once the failure rate crosses the ceiling (with enough runs)', () => {
    // 6 done + 6 failed → 50% failure rate, 12 terminal runs ≥ minRuns(5), ≥ maxFailureRate(0.5).
    const alerts = evaluatePlatformHealth(
      snapshot({ outcomes: { done: 6, failed: 6, total: 12, successRate: 0.5 } }),
      T,
    )
    expect(alerts).toEqual([{ reason: 'failure_rate_high', value: 0.5, threshold: 0.5 }])
  })

  it('stays quiet on a high failure rate below the minimum-runs sample', () => {
    // 1 done + 1 failed = 50% but only 2 terminal runs (< minRuns 5) → no alert.
    const alerts = evaluatePlatformHealth(
      snapshot({ outcomes: { done: 1, failed: 1, total: 2, successRate: 0.5 } }),
      T,
    )
    expect(alerts).toEqual([])
  })

  it('fires duration_p99_high when the p99 exceeds the ceiling', () => {
    const alerts = evaluatePlatformHealth(snapshot({ durations: { p99Ms: 90 * 60_000 } }), T)
    expect(alerts.map((a) => a.reason)).toEqual(['duration_p99_high'])
  })

  it('ignores a null p99 (no terminal runs)', () => {
    const alerts = evaluatePlatformHealth(
      snapshot({ durations: { count: 0, p99Ms: null, p90Ms: null, p50Ms: null } }),
      T,
    )
    expect(alerts).toEqual([])
  })

  it('fires backlog_high on live depth across every unfinished status', () => {
    const alerts = evaluatePlatformHealth(
      snapshot({ live: { running: 20, blocked: 15, paused: 10, pending: 10 } }),
      T,
    )
    expect(alerts).toEqual([{ reason: 'backlog_high', value: 55, threshold: 50 }])
  })

  it('can fire several conditions at once', () => {
    const alerts = evaluatePlatformHealth(
      snapshot({
        outcomes: { done: 2, failed: 8, total: 10, successRate: 0.2 },
        durations: { p99Ms: 120 * 60_000 },
      }),
      T,
    )
    expect(platformAlertReasons(alerts)).toEqual(['duration_p99_high', 'failure_rate_high'])
  })
})

describe('platformAlertReasons', () => {
  it('sorts the reason set so the dedup identity is order-independent', () => {
    expect(
      platformAlertReasons([
        { reason: 'failure_rate_high', value: 0.6, threshold: 0.5 },
        { reason: 'backlog_high', value: 60, threshold: 50 },
      ]),
    ).toEqual(['backlog_high', 'failure_rate_high'])
  })
})

describe('platformHealthCardContent', () => {
  it('produces stable content for a reason set, listing each condition', () => {
    const a = platformHealthCardContent(['backlog_high', 'failure_rate_high'], '1h')
    const b = platformHealthCardContent(['backlog_high', 'failure_rate_high'], '1h')
    expect(a).toEqual(b) // pure → byte-identical (the dedup guarantee)
    expect(a.body).toContain('the last hour')
    expect(a.body).toContain('failure rate')
    expect(a.body).toContain('backlog')
  })

  it('reads naturally for a single condition', () => {
    const { body } = platformHealthCardContent(['duration_p99_high'], '24h')
    expect(body).toContain('slow run durations')
    expect(body).toContain('the last 24 hours')
    expect(body).not.toContain(' and ')
  })
})
