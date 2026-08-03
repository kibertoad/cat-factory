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

/** Records each sweep pass's outcome and answers which sweeper is doing worst. */
export interface SweepHealthTracker {
  /** A pass of `sweep` threw. Increments its streak. */
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

export function createSweepHealthTracker(): SweepHealthTracker {
  const streaks = new Map<string, number>()
  return {
    recordFailure(sweep) {
      streaks.set(sweep, (streaks.get(sweep) ?? 0) + 1)
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
 * the health sweep reads.
 */
export const sweepHealth: SweepHealthTracker = createSweepHealthTracker()
