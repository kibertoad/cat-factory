import type { Clock, PlatformMetricsRepository } from '@cat-factory/kernel'
import type { PlatformObservability, PlatformObservabilityWindow } from '@cat-factory/contracts'
import { PLATFORM_WINDOWS, buildTrend, summarizeOutcomes } from './platform-observability.logic.js'

export interface PlatformObservabilityServiceDependencies {
  platformMetricsRepository: PlatformMetricsRepository
  clock: Clock
}

/**
 * Deployment-level (platform-operator) observability read: composes the aggregate rollups
 * behind {@link PlatformMetricsRepository} into the dashboard's windowed projection. Each
 * rollup is one SQL GROUP BY, run in parallel (independent aggregates, NOT an N+1); the
 * reshaping into totals / trend is the pure logic in `platform-observability.logic.ts`.
 */
export class PlatformObservabilityService {
  constructor(private readonly deps: PlatformObservabilityServiceDependencies) {}

  async summarize(
    accountId: string,
    window: PlatformObservabilityWindow,
  ): Promise<PlatformObservability> {
    const { windowMs, bucketMs } = PLATFORM_WINDOWS[window]
    const now = this.deps.clock.now()
    const since = now - windowMs
    const repo = this.deps.platformMetricsRepository
    const [outcomeRows, trendRows, failures, live, durations] = await Promise.all([
      repo.runOutcomesSince(accountId, since),
      repo.runOutcomeTrend(accountId, since, bucketMs),
      repo.failureKindBreakdown(accountId, since),
      repo.activeAndParkedCounts(accountId),
      repo.durationStatsSince(accountId, since),
    ])
    return {
      window,
      generatedAt: now,
      since,
      outcomes: summarizeOutcomes(outcomeRows),
      trend: { bucketMs, points: buildTrend(trendRows, since, now, bucketMs) },
      failures: failures.map((f) => ({ kind: f.failureKind, count: f.count })),
      live,
      durations,
    }
  }
}
