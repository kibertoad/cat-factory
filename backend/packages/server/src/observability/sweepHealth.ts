import { type OperationalMetrics, noopOperationalMetrics } from '@cat-factory/kernel'
import { operationalMetrics } from './operationalMetrics.js'

// Consecutive-failure tracking for the background sweepers, feeding the `sweep_degraded`
// platform-health condition (docs/initiatives/observability-logging-gaps.md, C5 / slice 4.2).
//
// Alerting on the WATCHER is the point. A sweeper that has failed every pass makes every other
// health condition stale without making any of them fire: the stale-run sweeper stops
// recovering lost runs (so nothing is re-driven and nothing is counted), the retention sweep
// stops bounding the tables (so a disk fills quietly), the platform-metrics sweep stops
// exporting (so the dashboard freezes on its last good reading and looks calm).
//
// This is a STREAK, not a rate, so it cannot ride the delta counters: `sweep.failed` says how
// many passes failed since the last flush, which a healthy sweeper that failed twice an hour
// ago and a wedged one that has failed for a week both satisfy at different times.
//
// Lifetime, stated rather than implied: this is in-memory, so on Node it spans the process and
// on the Worker it spans the ISOLATE — an eviction resets the streak and the condition needs a
// fresh run of failures to re-arm. That is the same trade-off, in the same place, that the run
// sweeper's `orphanedSince` map already makes and documents: it can only ever UNDER-report, so
// the failure mode is a missed alert rather than a false one, and buying more would mean a
// table write on every sweep tick of every deployment.

/** One sweeper's current consecutive-failure streak. */
export interface SweepFailureStreak {
  sweep: string
  consecutive: number
}

/**
 * Records each sweep pass's outcome and answers which sweeper is doing worst.
 *
 * The two signals a failed pass produces — the `sweep.failed` COUNTER (a rate) and the STREAK
 * (this) — are emitted by ONE call on purpose. They shipped as two calls at each site, and the
 * two facades promptly drifted into tracking disjoint sets: on Node every `startSweeper` sweep
 * recorded a streak but the two hand-rolled intervals recorded only the counter, while on the
 * Worker exactly one sweep recorded a streak and nothing else recorded either. A site that can
 * do half the job is a site that eventually does.
 */
export interface SweepHealthTracker {
  /**
   * A pass of `sweep` threw: increment its streak AND count it under `sweep.failed`. There is
   * deliberately no way to do one without the other.
   */
  recordFailure(sweep: string): void
  /** A pass of `sweep` completed. Resets its streak to 0 — the sweeper is working again. */
  recordSuccess(sweep: string): void
  /**
   * The worst current streak, or `undefined` when every sweeper's last pass succeeded (or
   * none has run yet). `undefined` rather than a zero-valued entry, because the health
   * evaluation treats an absent streak as "not tracked" and a present one as an observation.
   */
  worst(): SweepFailureStreak | undefined
}

/**
 * Build a tracker that reports every failed pass to `metrics` as well as accumulating its
 * streak. A unit test with nothing to export passes `noopOperationalMetrics`.
 */
export function createSweepHealthTracker(
  metrics: OperationalMetrics = noopOperationalMetrics,
): SweepHealthTracker {
  const streaks = new Map<string, number>()
  return {
    recordFailure(sweep) {
      streaks.set(sweep, (streaks.get(sweep) ?? 0) + 1)
      // Dimensioned by sweep name — a bounded set fixed at boot — so one sick sweeper is
      // identifiable among the fourteen rather than lost in a deployment-wide total.
      metrics.increment('sweep.failed', { sweep })
    },
    recordSuccess(sweep) {
      streaks.delete(sweep)
    },
    worst() {
      let worst: SweepFailureStreak | undefined
      for (const [sweep, consecutive] of streaks) {
        if (!worst || consecutive > worst.consecutive) worst = { sweep, consecutive }
      }
      return worst
    },
  }
}

/**
 * The process-wide (Node) / per-isolate (Worker) tracker, exported like `logger` and
 * `operationalMetrics` for the same reason: every sweeper must record into the ONE instance
 * the health sweep reads. Bound to the sibling `operationalMetrics` collector here, so the
 * counter and the streak can never be wired to different places.
 */
export const sweepHealth: SweepHealthTracker = createSweepHealthTracker(operationalMetrics)
