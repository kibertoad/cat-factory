import type {
  PlatformObservabilityWindow,
  PlatformOutcomeTotals,
  PlatformTrendPoint,
} from '@cat-factory/contracts'
import type { PlatformRunOutcome, PlatformRunTrendPoint } from '@cat-factory/kernel'

// Pure reshaping behind the platform-observability read: the port returns raw grouped
// rows; these functions fold them into the wire projection. Kept pure (no clock, no I/O)
// so they're unit-tested directly and reused by the future alert sweep.

/** Per-window sizing: how far back to aggregate and how wide each trend bucket is. */
export const PLATFORM_WINDOWS: Record<
  PlatformObservabilityWindow,
  { windowMs: number; bucketMs: number }
> = {
  '1h': { windowMs: 60 * 60_000, bucketMs: 5 * 60_000 }, // 12 × 5min buckets
  '24h': { windowMs: 24 * 60 * 60_000, bucketMs: 60 * 60_000 }, // 24 × 1h buckets
  '7d': { windowMs: 7 * 24 * 60 * 60_000, bucketMs: 6 * 60 * 60_000 }, // 28 × 6h buckets
}

/** Reduce the `(kind, status)` outcome rows into per-status totals + the success rate. */
export function summarizeOutcomes(rows: PlatformRunOutcome[]): PlatformOutcomeTotals {
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
