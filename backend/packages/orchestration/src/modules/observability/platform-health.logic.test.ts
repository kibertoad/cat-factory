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
  failures?: PlatformObservability['failures']
  trendPoints?: PlatformObservability['trend']['points']
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
    trend: { bucketMs: 300_000, points: over.trendPoints ?? [] },
    failures: over.failures ?? [],
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

// A trend series: `busy` buckets each carrying `perBucket` completed runs, then `idle` empty
// ones. The shape the stall condition reads — no second query, just the projection's own trend.
function trend(busy: number, idle: number, perBucket = 4) {
  const points: PlatformObservability['trend']['points'] = []
  for (let i = 0; i < busy; i++)
    points.push({ start: i * 300_000, done: perBucket, failed: 0, other: 0 })
  for (let i = 0; i < idle; i++)
    points.push({ start: (busy + i) * 300_000, done: 0, failed: 0, other: 0 })
  return points
}

describe('evaluatePlatformHealth: throughput_stalled', () => {
  it('fires when a busy window goes completely silent', () => {
    // The condition that exists because every OTHER one divides by runs and goes quiet at
    // total = 0 — so a deployment that stopped accepting work read as a quiet healthy one.
    const alerts = evaluatePlatformHealth(snapshot({ trendPoints: trend(6, 3) }), T)
    expect(platformAlertReasons(alerts)).toContain('throughput_stalled')
  })

  it('stays quiet for a deployment that is merely idle', () => {
    // An empty window is not a stall: nobody asked it to do anything. Alerting here is how a
    // zero-throughput alert gets muted, which costs the signal on the night it matters.
    const alerts = evaluatePlatformHealth(snapshot({ trendPoints: trend(6, 3, 0) }), T)
    expect(platformAlertReasons(alerts)).not.toContain('throughput_stalled')
  })

  it('stays quiet while work is still landing in the trailing buckets', () => {
    const alerts = evaluatePlatformHealth(snapshot({ trendPoints: trend(6, 2) }), T)
    expect(platformAlertReasons(alerts)).not.toContain('throughput_stalled')
  })

  it('cannot fire on a window too short to hold both halves', () => {
    // Not enough history to distinguish "stalled" from "just started" — the honest answer is
    // no alert, not a guess.
    const alerts = evaluatePlatformHealth(snapshot({ trendPoints: trend(0, 3) }), T)
    expect(platformAlertReasons(alerts)).not.toContain('throughput_stalled')
  })

  it('reports how far the silence ACTUALLY reaches, not the threshold it cleared', () => {
    // The platform COMPUTES the magnitude. Reporting `stalledBuckets` back made a stall that
    // had lasted all night read identically on the card to one that had just crossed the bar.
    const alerts = evaluatePlatformHealth(snapshot({ trendPoints: trend(2, 7) }), T)
    const stalled = alerts.find((a) => a.reason === 'throughput_stalled')
    expect(stalled).toEqual({ reason: 'throughput_stalled', value: 7, threshold: T.stalledBuckets })
    expect(stalled!.value).toBeGreaterThan(stalled!.threshold)
  })
})

describe('evaluatePlatformHealth: failure_kind_dominant', () => {
  it('fires when nearly every failure shares one kind', () => {
    // 100% `evicted` and 100% `agent` produce an identical failure RATE and need opposite
    // fixes, so the concentration is its own signal.
    const alerts = evaluatePlatformHealth(
      snapshot({
        outcomes: { total: 20, done: 10, failed: 10, successRate: 0.5 },
        failures: [
          { kind: 'evicted', count: 9 },
          { kind: 'agent', count: 1 },
        ],
      }),
      T,
    )
    expect(platformAlertReasons(alerts)).toContain('failure_kind_dominant')
  })

  it('stays quiet when failures are spread across kinds', () => {
    const alerts = evaluatePlatformHealth(
      snapshot({
        outcomes: { total: 20, done: 10, failed: 10, successRate: 0.5 },
        failures: [
          { kind: 'evicted', count: 5 },
          { kind: 'agent', count: 5 },
        ],
      }),
      T,
    )
    expect(platformAlertReasons(alerts)).not.toContain('failure_kind_dominant')
  })

  it('respects the minimum-sample gate, so one early failure is never "100% evicted"', () => {
    const alerts = evaluatePlatformHealth(
      snapshot({
        outcomes: { total: 1, done: 0, failed: 1, successRate: 0 },
        failures: [{ kind: 'evicted', count: 1 }],
      }),
      T,
    )
    expect(platformAlertReasons(alerts)).not.toContain('failure_kind_dominant')
  })
})

describe('evaluatePlatformHealth: sweep_degraded', () => {
  it('fires once a sweeper has failed the threshold number of consecutive passes', () => {
    const alerts = evaluatePlatformHealth(snapshot({}), T, { sweep: 'retention', consecutive: 3 })
    expect(platformAlertReasons(alerts)).toContain('sweep_degraded')
  })

  it('stays quiet below the threshold', () => {
    const alerts = evaluatePlatformHealth(snapshot({}), T, { sweep: 'retention', consecutive: 1 })
    expect(platformAlertReasons(alerts)).not.toContain('sweep_degraded')
  })

  it('cannot fire when the caller tracks no streak', () => {
    // Absent is "not tracked", not "nothing failed" — the caller that supplies nothing gets no
    // claim either way.
    expect(platformAlertReasons(evaluatePlatformHealth(snapshot({}), T))).not.toContain(
      'sweep_degraded',
    )
  })
})

describe('platformHealthCardContent covers every reason', () => {
  it('renders a phrase for each new reason rather than the fallback', () => {
    // The `Record<PlatformAlertReason, string>` makes a missing phrase a typecheck failure, but
    // not a WRONG one — this pins that each new reason reaches the body.
    for (const reason of [
      'throughput_stalled',
      'failure_kind_dominant',
      'sweep_degraded',
    ] as const) {
      const { body } = platformHealthCardContent([reason], '1h')
      expect(body).not.toContain('a health threshold was crossed')
    }
  })
})
