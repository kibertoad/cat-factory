import { describe, expect, it } from 'vitest'
import type { PlatformObservability } from '@cat-factory/contracts'
import {
  DEFAULT_PLATFORM_ALERT_THRESHOLDS,
  alertsHaveRunEvidence,
  evaluatePlatformHealth,
  platformAlertFailureKinds,
  platformAlertReasons,
  platformHealthCardContent,
  resolveAccountAlertConfig,
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
    source: 'runs' as const,
    rolledUpThrough: null,
    trend: { bucketMs: 300_000, points: over.trendPoints ?? [] },
    failures: over.failures ?? [],
    gates: [],
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

describe('evaluatePlatformHealth: failure_kind_rate_high', () => {
  /**
   * A busy window whose 10 failures spread across three kinds, 2 of them evictions: 20% evicted,
   * and no kind anywhere near dominance, so the per-kind condition is the only thing that can
   * see the evictions at all.
   */
  const MIXED = {
    outcomes: { total: 30, done: 20, failed: 10, successRate: 2 / 3 },
    failures: [
      { kind: 'agent', count: 5 },
      { kind: 'job_failed', count: 3 },
      { kind: 'evicted', count: 2 },
    ],
  }

  it('fires for a kind over its own ceiling, far below dominance', () => {
    // The whole point of the condition: 20% evictions never approaches the 80% dominant share,
    // and is still the container substrate failing one run in five.
    const alerts = evaluatePlatformHealth(snapshot(MIXED), {
      ...T,
      failureKindRules: [{ kind: 'evicted', maxShare: 0.1 }],
    })
    expect(alerts).toContainEqual({
      reason: 'failure_kind_rate_high',
      kind: 'evicted',
      value: 0.2,
      threshold: 0.1,
    })
    // And it is its OWN condition, not a re-spelling of the dominant one, which stays quiet.
    expect(platformAlertReasons(alerts)).not.toContain('failure_kind_dominant')
  })

  it('stays quiet for a kind under its ceiling, and for one that never occurred', () => {
    const alerts = evaluatePlatformHealth(snapshot(MIXED), {
      ...T,
      failureKindRules: [
        { kind: 'evicted', maxShare: 0.5 },
        // A kind with no slice in the taxonomy never happened, which is the healthy answer.
        { kind: 'timeout', maxShare: 0.01 },
      ],
    })
    expect(alerts).toEqual([])
  })

  it('honours the per-rule minimum count, which a low ceiling needs and minRuns cannot give', () => {
    // 1 eviction out of 2 failures across 6 terminal runs: past `minRuns`, past a 10% ceiling,
    // and exactly the blip a per-kind rule must not page on.
    const oneEviction = {
      outcomes: { total: 6, done: 4, failed: 2, successRate: 2 / 3 },
      failures: [
        { kind: 'agent', count: 1 },
        { kind: 'evicted', count: 1 },
      ],
    }
    const rule = { kind: 'evicted', maxShare: 0.1, minCount: 3 }
    expect(
      evaluatePlatformHealth(snapshot(oneEviction), { ...T, failureKindRules: [rule] }),
    ).toEqual([])
    // Same window, same ceiling, without the guard: it fires. The guard is what is doing the work.
    expect(
      platformAlertReasons(
        evaluatePlatformHealth(snapshot(oneEviction), {
          ...T,
          failureKindRules: [{ kind: 'evicted', maxShare: 0.1 }],
        }),
      ),
    ).toContain('failure_kind_rate_high')
  })

  it('fires AT the configured share, not only above it', () => {
    // The share an operator types is the TRIGGER POINT, matching `failure_kind_dominant` and
    // `failure_rate_high`. Pinned because every operator-facing string describing this rule
    // ("reaches", "at or over") is only true of `>=`, and a later `>` would leave them lying
    // about the one number the operator picked.
    const exactly = evaluatePlatformHealth(snapshot(MIXED), {
      ...T,
      failureKindRules: [{ kind: 'evicted', maxShare: 0.2 }],
    })
    expect(platformAlertFailureKinds(exactly)).toEqual(['evicted'])
    // And a hair above the observed share stays quiet, so the boundary is where it says it is.
    const justOver = evaluatePlatformHealth(snapshot(MIXED), {
      ...T,
      failureKindRules: [{ kind: 'evicted', maxShare: 0.2001 }],
    })
    expect(justOver).toEqual([])
  })

  it('respects the shared minimum-run sample, like every other failure condition', () => {
    const alerts = evaluatePlatformHealth(
      snapshot({
        outcomes: { total: 1, done: 0, failed: 1, successRate: 0 },
        failures: [{ kind: 'evicted', count: 1 }],
      }),
      { ...T, failureKindRules: [{ kind: 'evicted', maxShare: 0.1 }] },
    )
    expect(alerts).toEqual([])
  })

  it('fires one alert per crossed rule, deduped to a single reason and named by kind', () => {
    const alerts = evaluatePlatformHealth(
      snapshot({
        outcomes: { total: 30, done: 20, failed: 10, successRate: 2 / 3 },
        failures: [
          { kind: 'evicted', count: 5 },
          { kind: 'timeout', count: 5 },
        ],
      }),
      {
        ...T,
        failureKindRules: [
          { kind: 'timeout', maxShare: 0.2 },
          { kind: 'evicted', maxShare: 0.2 },
        ],
      },
    )
    // Two conditions fired, but the card's reason identity carries the code ONCE: repeating it
    // per rule would churn the identity while naming none of the kinds that actually changed.
    expect(platformAlertReasons(alerts)).toEqual(['failure_kind_rate_high'])
    // The kinds are the rest of that identity, sorted, and are what a swap of kind changes.
    expect(platformAlertFailureKinds(alerts)).toEqual(['evicted', 'timeout'])
  })

  it('has no per-kind condition at all with the shipped defaults', () => {
    // The default is an empty rule list, so an operator who configured nothing sees byte-for-byte
    // the prior behaviour rather than a threshold the platform guessed at.
    expect(DEFAULT_PLATFORM_ALERT_THRESHOLDS.failureKindRules).toEqual([])
    expect(platformAlertFailureKinds(evaluatePlatformHealth(snapshot(MIXED), T))).toEqual([])
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
      'failure_kind_rate_high',
      'sweep_degraded',
    ] as const) {
      const { body } = platformHealthCardContent([reason], '1h')
      expect(body).not.toContain('a health threshold was crossed')
    }
  })

  it('names the kinds a per-kind rule fired for, rather than "a failure kind"', () => {
    // The kinds are part of the dedup identity, so they are stable for the length of an
    // incident and can be CONTENT — unlike the shares behind them, which move every sweep. And
    // naming them is the point: "evicted" says which system to go and look at.
    const { body } = platformHealthCardContent(['failure_kind_rate_high'], '1h', [
      'evicted',
      'timeout',
    ])
    expect(body).toContain('evicted and timeout failures at or over the rate set for them')
  })
})

describe('resolveAccountAlertConfig', () => {
  const deployment = {
    enabled: true,
    window: '1h' as const,
    thresholds: DEFAULT_PLATFORM_ALERT_THRESHOLDS,
  }

  it('inherits every threshold when the account stored nothing', () => {
    const resolved = resolveAccountAlertConfig(deployment, undefined)
    expect(resolved).toEqual(deployment)
  })

  it('overrides only the fields the account set, per field', () => {
    const resolved = resolveAccountAlertConfig(deployment, {
      window: '24h',
      thresholds: { maxFailureRate: 0.9 },
    })
    expect(resolved.window).toBe('24h')
    expect(resolved.thresholds.maxFailureRate).toBe(0.9)
    // Everything else still comes from the deployment, including the neighbours of the field
    // that WAS set; a spread-based merge would have wiped them.
    expect(resolved.thresholds.minRuns).toBe(DEFAULT_PLATFORM_ALERT_THRESHOLDS.minRuns)
    expect(resolved.thresholds.maxBacklog).toBe(DEFAULT_PLATFORM_ALERT_THRESHOLDS.maxBacklog)
  })

  it('keeps a stored ZERO as a real threshold rather than reading it as absent', () => {
    // The whole point of the merge: `minStalledPriorRuns: 0` says "page even on an idle
    // window". Collapsing it into "unset" would silently restore the deployment default and
    // mute exactly the account that asked for the strictest setting available.
    const resolved = resolveAccountAlertConfig(deployment, {
      thresholds: { minStalledPriorRuns: 0 },
    })
    expect(resolved.thresholds.minStalledPriorRuns).toBe(0)
  })

  it('lets a stored rule LIST replace the deployment rules, empty included', () => {
    const withRules = {
      ...deployment,
      thresholds: {
        ...DEFAULT_PLATFORM_ALERT_THRESHOLDS,
        failureKindRules: [{ kind: 'evicted', maxShare: 0.1 }],
      },
    }
    // Absent still inherits, like every scalar.
    expect(resolveAccountAlertConfig(withRules, {}).thresholds.failureKindRules).toEqual([
      { kind: 'evicted', maxShare: 0.1 },
    ])
    // A stored list REPLACES rather than merges: an account that disagrees with a deployment
    // rule must be able to drop it, and quietly reinstating one is the worse pager mistake.
    expect(
      resolveAccountAlertConfig(withRules, {
        thresholds: { failureKindRules: [{ kind: 'timeout', maxShare: 0.3 }] },
      }).thresholds.failureKindRules,
    ).toEqual([{ kind: 'timeout', maxShare: 0.3 }])
    // And EMPTY is a real setting ("no per-kind rules here"), not an absence.
    expect(
      resolveAccountAlertConfig(withRules, { thresholds: { failureKindRules: [] } }).thresholds
        .failureKindRules,
    ).toEqual([])
  })

  it('lets an account mute itself but never enable alerting the deployment never started', () => {
    expect(resolveAccountAlertConfig(deployment, { enabled: false }).enabled).toBe(false)
    // The env switch decides whether the sweep runs at all, so a stored `true` cannot start a
    // timer that was never started, so it must not read as "alerting is on for this account".
    expect(
      resolveAccountAlertConfig({ ...deployment, enabled: false }, { enabled: true }).enabled,
    ).toBe(false)
  })
})

describe('alertsHaveRunEvidence', () => {
  it('is true only for the conditions a failing run can be shown for', () => {
    expect(alertsHaveRunEvidence(['failure_rate_high'])).toBe(true)
    expect(alertsHaveRunEvidence(['failure_kind_dominant'])).toBe(true)
    expect(alertsHaveRunEvidence(['failure_kind_rate_high'])).toBe(true)
    expect(alertsHaveRunEvidence(['backlog_high', 'failure_rate_high'])).toBe(true)
  })

  it('is false for conditions with no failing run behind them', () => {
    // Linking a backlog or a stall alert to a run list that resolved to nothing would read as
    // "there are no failures", which is the opposite of what those alerts are saying.
    expect(alertsHaveRunEvidence(['backlog_high'])).toBe(false)
    expect(alertsHaveRunEvidence(['throughput_stalled', 'duration_p99_high'])).toBe(false)
    expect(alertsHaveRunEvidence([])).toBe(false)
  })
})
