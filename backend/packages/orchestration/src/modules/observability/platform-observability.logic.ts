import type {
  PlatformFailureSlice,
  PlatformGateStat,
  PlatformObservabilityWindow,
  PlatformOutcomeTotals,
  PlatformTrendPoint,
  PlatformTrendSource,
} from '@cat-factory/contracts'
import type {
  PlatformDailyRunCount,
  PlatformGateOutcomeCount,
  PlatformRunTrendPoint,
} from '@cat-factory/kernel'

// Pure reshaping behind the platform-observability read: the port returns raw grouped
// rows; these functions fold them into the wire projection. Kept pure (no clock, no I/O)
// so they're unit-tested directly and reused by the alert sweep.

/** A day, in ms: the daily rollup's bucket width and the long windows' trend resolution. */
export const DAY_MS = 24 * 60 * 60_000

/**
 * Per-window sizing: how far back to aggregate, how wide each trend bucket is, and which
 * store answers it.
 *
 * The short windows scan `agent_runs` live. The long ones read the daily rollup: a `90d`
 * window at any finer resolution would scan a quarter of every run the deployment has ever
 * made on each dashboard load, which is the cost the rollup exists to remove, and it would
 * do it while producing a series nobody can read at that density anyway.
 */
export const PLATFORM_WINDOWS: Record<
  PlatformObservabilityWindow,
  { windowMs: number; bucketMs: number; source: PlatformTrendSource }
> = {
  '1h': { windowMs: 60 * 60_000, bucketMs: 5 * 60_000, source: 'runs' }, // 12 × 5min buckets
  '24h': { windowMs: 24 * 60 * 60_000, bucketMs: 60 * 60_000, source: 'runs' }, // 24 × 1h
  '7d': { windowMs: 7 * DAY_MS, bucketMs: 6 * 60 * 60_000, source: 'runs' }, // 28 × 6h
  '30d': { windowMs: 30 * DAY_MS, bucketMs: DAY_MS, source: 'daily-rollup' },
  '90d': { windowMs: 90 * DAY_MS, bucketMs: DAY_MS, source: 'daily-rollup' },
}

/** Reduce the `(kind, status)` outcome rows into per-status totals + the success rate. */
export function summarizeOutcomes(
  // Only `status` + `count` are read, so this also folds the daily-rollup rows, which carry
  // no run kind. Typed structurally rather than against `PlatformRunOutcome` so the two
  // sources share one reduction instead of drifting into two that must agree.
  rows: readonly { status: string; count: number }[],
): PlatformOutcomeTotals {
  const totals: PlatformOutcomeTotals = {
    total: 0,
    done: 0,
    failed: 0,
    running: 0,
    blocked: 0,
    paused: 0,
    other: 0,
    successRate: null,
  }
  for (const r of rows) {
    totals.total += r.count
    switch (r.status) {
      case 'done':
        totals.done += r.count
        break
      case 'failed':
        totals.failed += r.count
        break
      case 'running':
        totals.running += r.count
        break
      case 'blocked':
        totals.blocked += r.count
        break
      case 'paused':
        totals.paused += r.count
        break
      default:
        totals.other += r.count
    }
  }
  const terminal = totals.done + totals.failed
  totals.successRate = terminal > 0 ? totals.done / terminal : null
  return totals
}

/**
 * Fold the sparse `(bucketStart, status)` trend rows into a contiguous, zero-filled,
 * oldest-first series spanning `[since, now]` at `bucketMs` resolution — so the sparkline
 * shows empty buckets as zeros rather than collapsing gaps.
 */
export function buildTrend(
  points: PlatformRunTrendPoint[],
  since: number,
  now: number,
  bucketMs: number,
): PlatformTrendPoint[] {
  const byStart = new Map<number, PlatformTrendPoint>()
  const first = Math.floor(since / bucketMs) * bucketMs
  const last = Math.floor(now / bucketMs) * bucketMs
  for (let start = first; start <= last; start += bucketMs) {
    byStart.set(start, { start, done: 0, failed: 0, other: 0 })
  }
  for (const p of points) {
    let entry = byStart.get(p.bucketStart)
    if (!entry) {
      entry = { start: p.bucketStart, done: 0, failed: 0, other: 0 }
      byStart.set(p.bucketStart, entry)
    }
    if (p.status === 'done') entry.done += p.count
    else if (p.status === 'failed') entry.failed += p.count
    else entry.other += p.count
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start)
}

/**
 * The daily-rollup rows as trend input. The rollup splits a `failed` day into one row per
 * failure kind, so the same day appears several times; `buildTrend` sums them, which is why
 * this is a projection rather than a regrouping.
 */
export function dailyTrendRows(rows: readonly PlatformDailyRunCount[]): PlatformRunTrendPoint[] {
  return rows.map((r) => ({ bucketStart: r.dayStart, status: r.status, count: r.count }))
}

/**
 * The failure taxonomy folded out of the daily-rollup rows, most frequent first: the
 * long-window counterpart of `failureKindBreakdown`. Only `failed` rows carry a kind; a row
 * that somehow lacks one is counted as `unknown` rather than dropped, so the slice totals
 * still add up to the window's failure count.
 */
export function dailyFailureSlices(rows: readonly PlatformDailyRunCount[]): PlatformFailureSlice[] {
  const byKind = new Map<string, number>()
  for (const r of rows) {
    if (r.status !== 'failed') continue
    const kind = r.failureKind ?? 'unknown'
    byKind.set(kind, (byKind.get(kind) ?? 0) + r.count)
  }
  return [...byKind.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind))
}

/**
 * Fold the `(gateKind, helperKind, outcome)` buckets into one statistic per gate kind, busiest
 * first. The port groups by outcome because that is one `GROUP BY`; the dashboard reads a gate
 * kind as a single row, so passed/exhausted become columns here rather than rows.
 *
 * `helperKind` is taken from whichever bucket names one: a gate's helper is a property of the
 * gate definition, so the buckets agree, but a gate that passed cleanly every time in the
 * window legitimately recorded no helper at all and must not blank out the label.
 */
export function summarizeGateOutcomes(
  rows: readonly PlatformGateOutcomeCount[],
): PlatformGateStat[] {
  const byKind = new Map<string, PlatformGateStat>()
  for (const r of rows) {
    let stat = byKind.get(r.gateKind)
    if (!stat) {
      stat = {
        gateKind: r.gateKind,
        helperKind: null,
        gates: 0,
        passed: 0,
        exhausted: 0,
        cleanPasses: 0,
        attempts: 0,
        helperFailures: 0,
      }
      byKind.set(r.gateKind, stat)
    }
    stat.helperKind ??= r.helperKind
    stat.gates += r.gates
    stat.attempts += r.attempts
    stat.helperFailures += r.helperFailures
    if (r.outcome === 'passed') {
      stat.passed += r.gates
      stat.cleanPasses += r.cleanGates
    } else {
      stat.exhausted += r.gates
    }
  }
  return [...byKind.values()].sort(
    (a, b) => b.gates - a.gates || a.gateKind.localeCompare(b.gateKind),
  )
}
