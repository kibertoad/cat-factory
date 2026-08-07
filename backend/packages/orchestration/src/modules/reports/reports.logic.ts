import type {
  ReportActivityRow,
  ReportSpendRow,
  ReportSpendSource,
  ReportTotals,
  ReportTrendPoint,
  ReportWindow,
} from '@cat-factory/contracts'
import type {
  ReportActivityGroup,
  ReportSpendGroup,
  ReportSpendTrendBucket,
} from '@cat-factory/kernel'

// Pure reshaping behind the reports read: the port returns raw grouped rows; these
// functions fold them into the wire projection. Kept pure (no clock, no I/O) so they're
// unit-tested directly, mirroring `platform-observability.logic.ts`.

/**
 * The window's start, snapped DOWN to a bucket edge.
 *
 * `until - windowMs` lands wherever the request happened to arrive, which leaves the trend's
 * first bucket holding a fraction of a bucket's data while rendering at the same width as
 * its complete neighbours — a reader has no way to tell the short leading column from a
 * genuinely quiet period, which is the one thing a trend must not get wrong. Snapping down
 * makes every bucket complete except the trailing in-progress one, whose partialness is
 * inherent and understood. The cost is that a window covers UP TO one bucket more than its
 * nominal length; the projection reports the real `since` so the view says what it charted.
 */
export function alignWindowStart(until: number, windowMs: number, bucketMs: number): number {
  return Math.floor((until - windowMs) / bucketMs) * bucketMs
}

/**
 * Per-window sizing: how far back to aggregate, how wide each trend bucket is, and WHICH
 * store answers the spend half.
 *
 * The two long windows read the durable `spend_days` rollup. That is not only a cost
 * decision (though a quarter of a busy deployment's ledger is a lot of rows to group at read
 * time): those are the windows a TCO question is actually asked over, and only the rollup
 * carries the attribution as it stood when the money was spent. The two short windows stay on
 * the ledger, where the rollup's sweep cadence would be visible as a missing tail.
 *
 * Every rollup-backed bucket is a whole number of UTC days, which is what lets a day-grained
 * table serve them: `alignWindowStart` snaps `since` down to a bucket edge, and a multiple of
 * one day (`30d`) or three (`90d`) is always a UTC midnight.
 */
export const REPORT_WINDOWS: Record<
  ReportWindow,
  { windowMs: number; bucketMs: number; source: ReportSpendSource }
> = {
  // 24 × 1h buckets
  '24h': { windowMs: 24 * 60 * 60_000, bucketMs: 60 * 60_000, source: 'ledger' },
  // 28 × 6h buckets
  '7d': { windowMs: 7 * 24 * 60 * 60_000, bucketMs: 6 * 60 * 60_000, source: 'ledger' },
  // 30 × 1d buckets
  '30d': { windowMs: 30 * 24 * 60 * 60_000, bucketMs: 24 * 60 * 60_000, source: 'daily-rollup' },
  // 30 × 3d buckets
  '90d': {
    windowMs: 90 * 24 * 60 * 60_000,
    bucketMs: 3 * 24 * 60 * 60_000,
    source: 'daily-rollup',
  },
}

/** Widen a port spend group into its wire row (the shapes match; this pins the boundary). */
export function toSpendRow(group: ReportSpendGroup): ReportSpendRow {
  return {
    key: group.key,
    label: group.label,
    inputTokens: group.inputTokens,
    outputTokens: group.outputTokens,
    calls: group.calls,
    meteredCost: group.meteredCost,
    subscriptionCost: group.subscriptionCost,
  }
}

/** Widen a port activity group into its wire row. */
export function toActivityRow(group: ReportActivityGroup): ReportActivityRow {
  return {
    key: group.key,
    label: group.label,
    runs: group.runs,
    done: group.done,
    failed: group.failed,
    running: group.running,
    other: group.other,
    avgDurationMs: group.avgDurationMs,
  }
}

/**
 * Window-wide totals, summed from ONE breakdown. Every spend breakdown partitions the
 * same ledger rows, so any of them totals identically — folding the model breakdown in JS
 * costs nothing and avoids a sixth aggregate query purely to restate it.
 */
export function foldTotals(rows: ReportSpendRow[]): ReportTotals {
  const totals: ReportTotals = {
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
    meteredCost: 0,
    subscriptionCost: 0,
  }
  for (const row of rows) {
    totals.inputTokens += row.inputTokens
    totals.outputTokens += row.outputTokens
    totals.calls += row.calls
    totals.meteredCost += row.meteredCost
    totals.subscriptionCost += row.subscriptionCost
  }
  return totals
}

/**
 * Fold the sparse trend buckets into a contiguous, zero-filled, oldest-first series
 * spanning `[since, until]` at `bucketMs` resolution — so a quiet period reads as a flat
 * run of zeros rather than a collapsed gap that implies continuous spend.
 */
export function buildSpendTrend(
  buckets: ReportSpendTrendBucket[],
  since: number,
  until: number,
  bucketMs: number,
): ReportTrendPoint[] {
  const byStart = new Map<number, ReportTrendPoint>()
  const empty = (start: number): ReportTrendPoint => ({
    start,
    meteredCost: 0,
    subscriptionCost: 0,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
  })
  const first = Math.floor(since / bucketMs) * bucketMs
  const last = Math.floor(until / bucketMs) * bucketMs
  for (let start = first; start <= last; start += bucketMs) byStart.set(start, empty(start))
  for (const bucket of buckets) {
    // A bucket outside the zero-filled span (a clock skew, or a row stamped in the
    // future) still belongs in the series — add it rather than silently discarding spend.
    const point = byStart.get(bucket.bucketStart) ?? empty(bucket.bucketStart)
    point.meteredCost += bucket.meteredCost
    point.subscriptionCost += bucket.subscriptionCost
    point.calls += bucket.calls
    point.inputTokens += bucket.inputTokens
    point.outputTokens += bucket.outputTokens
    byStart.set(bucket.bucketStart, point)
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start)
}
