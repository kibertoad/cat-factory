import type {
  Clock,
  CommitProjectionRepository,
  LlmCallMetricRepository,
  RateLimitRepository,
  TokenUsageRepository,
} from '@cat-factory/kernel'

// Retention sweep for the tables that don't self-limit (see
// docs/storage-and-retention.md): the append-only `token_usage` ledger, the
// `github_rate_limits` telemetry, and the `github_commits` projection. Cron
// invokes this alongside the run sweeper; each table is pruned to its configured
// age window. Pure orchestration over its ports so it is unit-testable with the
// real D1 repositories (mirroring the execution sweeper's style).

/** Per-table retention ages in milliseconds; 0 (or less) disables that table's pass. */
export interface RetentionPolicy {
  tokenUsageMs: number
  rateLimitMs: number
  commitMs: number
  llmCallMetricsMs: number
}

export interface RetentionDeps {
  tokenUsageRepository: TokenUsageRepository
  rateLimitRepository: RateLimitRepository
  commitRepository: CommitProjectionRepository
  llmCallMetricRepository: LlmCallMetricRepository
  clock: Clock
  policy: RetentionPolicy
}

/** Rows reclaimed from each table, for logging. */
export interface RetentionResult {
  tokenUsage: number
  rateLimits: number
  commits: number
  llmCallMetrics: number
}

/** Delete rows older than `now - windowMs`, treating a non-positive window as "disabled". */
async function prune(
  windowMs: number,
  now: number,
  del: (cutoff: number) => Promise<number>,
): Promise<number> {
  if (windowMs <= 0) return 0
  return del(now - windowMs)
}

/**
 * Prune each unbounded table to its retention window. The deletes are
 * range-scans on indexed columns and usually reclaim nothing, so this is cheap
 * to run on the every-2-min cron. Returns the counts removed per table.
 */
export async function sweepRetention({
  tokenUsageRepository,
  rateLimitRepository,
  commitRepository,
  llmCallMetricRepository,
  clock,
  policy,
}: RetentionDeps): Promise<RetentionResult> {
  const now = clock.now()
  return {
    tokenUsage: await prune(policy.tokenUsageMs, now, (c) =>
      tokenUsageRepository.deleteOlderThan(c),
    ),
    rateLimits: await prune(policy.rateLimitMs, now, (c) => rateLimitRepository.deleteOlderThan(c)),
    commits: await prune(policy.commitMs, now, (c) => commitRepository.deleteOlderThan(c)),
    llmCallMetrics: await prune(policy.llmCallMetricsMs, now, (c) =>
      llmCallMetricRepository.deleteOlderThan(c),
    ),
  }
}
