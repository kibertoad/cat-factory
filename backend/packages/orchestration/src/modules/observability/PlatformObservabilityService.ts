import type { Clock, GateOutcomeRepository, PlatformMetricsRepository } from '@cat-factory/kernel'
import type { PlatformObservability, PlatformObservabilityWindow } from '@cat-factory/contracts'
import {
  PLATFORM_WINDOWS,
  buildTrend,
  dailyFailureSlices,
  dailyTrendRows,
  summarizeGateOutcomes,
  summarizeOutcomes,
} from './platform-observability.logic.js'

export interface PlatformObservabilityServiceDependencies {
  platformMetricsRepository: PlatformMetricsRepository
  /**
   * The settled-gate projection behind the attempt statistics. Optional so a facade that has
   * not wired it (or a test) degrades to an EMPTY gate list rather than failing the whole
   * dashboard read: the projection is the newest of the sinks and the only one whose absence
   * costs a section rather than the page.
   */
  gateOutcomeRepository?: GateOutcomeRepository
  clock: Clock
}

/**
 * Deployment-level (platform-operator) observability read: composes the aggregate rollups
 * behind {@link PlatformMetricsRepository} into the dashboard's windowed projection. Each
 * rollup is one SQL GROUP BY, run in parallel (independent aggregates, NOT an N+1); the
 * reshaping into totals / trend is the pure logic in `platform-observability.logic.ts`.
 *
 * Two windows' worth of routing lives here: `1h`/`24h`/`7d` scan `agent_runs` live, while
 * `30d`/`90d` read the daily rollup the retention sweep materialises. The projection SAYS
 * which answered (`source`) and, on the rollup path, how far the rollup actually reaches
 * (`rolledUpThrough`), because an un-materialised rollup and an idle quarter produce the same
 * empty series and are opposite facts.
 */
export class PlatformObservabilityService {
  constructor(private readonly deps: PlatformObservabilityServiceDependencies) {}

  async summarize(
    accountId: string,
    window: PlatformObservabilityWindow,
  ): Promise<PlatformObservability> {
    const { windowMs, bucketMs, source } = PLATFORM_WINDOWS[window]
    const now = this.deps.clock.now()
    const since = now - windowMs
    const repo = this.deps.platformMetricsRepository
    // The live-depth snapshot, the duration percentiles and the gate statistics are the same
    // read on every window: the first two are not bucketed (so there is nothing to roll up),
    // and the gate projection is small enough to scan directly at any window.
    const [shared, windowed] = await Promise.all([
      Promise.all([
        repo.activeAndParkedCounts(accountId),
        repo.durationStatsSince(accountId, since),
        this.deps.gateOutcomeRepository?.statsSince(accountId, since) ?? Promise.resolve([]),
      ]),
      source === 'daily-rollup'
        ? this.summarizeFromRollup(accountId, since, now, bucketMs)
        : this.summarizeFromRuns(accountId, since, now, bucketMs),
    ])
    const [live, durations, gateRows] = shared
    return {
      window,
      generatedAt: now,
      since,
      source,
      ...windowed,
      live,
      durations,
      gates: summarizeGateOutcomes(gateRows),
    }
  }

  /**
   * A bounded, per-workspace-capped sample of the account's recently FAILED runs since
   * `sinceEpochMs`: the evidence a `platform_health` alert card deep-links to.
   *
   * On the service rather than read straight off the port because the alert sweep is a
   * consumer of this module, not of the store: everything else it needs already arrives
   * through `summarize`, and reaching past the service for one query is how a second,
   * differently-scoped copy of the account filter gets written.
   */
  async failingRuns(accountId: string, sinceEpochMs: number, perWorkspaceLimit: number) {
    return this.deps.platformMetricsRepository.recentFailedRuns(
      accountId,
      sinceEpochMs,
      perWorkspaceLimit,
    )
  }

  /** The live path: three independent aggregates over `agent_runs`. */
  private async summarizeFromRuns(
    accountId: string,
    since: number,
    now: number,
    bucketMs: number,
  ): Promise<Pick<PlatformObservability, 'outcomes' | 'trend' | 'failures' | 'rolledUpThrough'>> {
    const repo = this.deps.platformMetricsRepository
    const [outcomeRows, trendRows, failures] = await Promise.all([
      repo.runOutcomesSince(accountId, since),
      repo.runOutcomeTrend(accountId, since, bucketMs),
      repo.failureKindBreakdown(accountId, since),
    ])
    return {
      outcomes: summarizeOutcomes(outcomeRows),
      // Null, not a stale watermark: there is no rollup in this path, so there is nothing
      // about it that could be behind, and reporting one would invite the reader to believe
      // the live numbers were bounded by it.
      rolledUpThrough: null,
      trend: { bucketMs, points: buildTrend(trendRows, since, now, bucketMs) },
      failures: failures.map((f) => ({ kind: f.failureKind, count: f.count })),
    }
  }

  /**
   * The long-window path: ONE read of the daily rollup serves the totals, the trend and the
   * failure taxonomy alike (each rollup row carries the day, the status and, for a failure,
   * its kind), plus the watermark read that says how far the rollup reaches.
   */
  private async summarizeFromRollup(
    accountId: string,
    since: number,
    now: number,
    bucketMs: number,
  ): Promise<Pick<PlatformObservability, 'outcomes' | 'trend' | 'failures' | 'rolledUpThrough'>> {
    const repo = this.deps.platformMetricsRepository
    const [rows, rolledUpThrough] = await Promise.all([
      repo.dailyRunTotalsSince(accountId, since),
      repo.dailyRollupWatermark(),
    ])
    return {
      outcomes: summarizeOutcomes(rows),
      rolledUpThrough,
      trend: { bucketMs, points: buildTrend(dailyTrendRows(rows), since, now, bucketMs) },
      failures: dailyFailureSlices(rows),
    }
  }
}
