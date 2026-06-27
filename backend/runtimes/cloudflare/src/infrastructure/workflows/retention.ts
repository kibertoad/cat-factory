import type {
  AgentContextSnapshotRepository,
  Clock,
  CommitProjectionRepository,
  LlmCallMetricRepository,
  PasswordResetTokenRepository,
  PipelineScheduleRepository,
  ProvisioningLogRepository,
  RateLimitRepository,
  TokenUsageRepository,
} from '@cat-factory/kernel'

/** Recurring-pipeline run history is kept ~1 week (the inspector's window). */
export const SCHEDULE_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

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
  /**
   * High-churn provisioning event log (separate D1 db). Always set by the config loader
   * (mirrors Node + the shared {@link RetentionConfig}); the prune is still skipped when
   * the `provisioningLogRepository` is absent (no PROVISIONING_DB binding) or the window
   * is non-positive.
   */
  provisioningLogMs: number
}

export interface RetentionDeps {
  tokenUsageRepository: TokenUsageRepository
  rateLimitRepository: RateLimitRepository
  commitRepository: CommitProjectionRepository
  llmCallMetricRepository: LlmCallMetricRepository
  /** Agent-context snapshots; pruned on the same window as the LLM call telemetry. */
  agentContextSnapshotRepository: AgentContextSnapshotRepository
  /** Optional: prunes recurring-pipeline run history to {@link SCHEDULE_RUN_RETENTION_MS}. */
  pipelineScheduleRepository?: PipelineScheduleRepository
  /** Optional: the provisioning event log (only when the PROVISIONING_DB binding is present). */
  provisioningLogRepository?: ProvisioningLogRepository
  /** Optional: password-reset tokens past their own TTL (single-use + 1h expiry). */
  passwordResetTokenRepository?: PasswordResetTokenRepository
  clock: Clock
  policy: RetentionPolicy
}

/** Rows reclaimed from each table, for logging. */
export interface RetentionResult {
  tokenUsage: number
  rateLimits: number
  commits: number
  llmCallMetrics: number
  agentContextSnapshots: number
  scheduleRuns: number
  provisioningLog: number
  passwordResetTokens: number
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
  agentContextSnapshotRepository,
  pipelineScheduleRepository,
  provisioningLogRepository,
  passwordResetTokenRepository,
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
    // Same window as the LLM call telemetry (heavy prompt + injected-file bodies).
    agentContextSnapshots: await prune(policy.llmCallMetricsMs, now, (c) =>
      agentContextSnapshotRepository.deleteOlderThan(c),
    ),
    scheduleRuns: pipelineScheduleRepository
      ? await prune(SCHEDULE_RUN_RETENTION_MS, now, (c) =>
          pipelineScheduleRepository.pruneRunsBefore(c),
        )
      : 0,
    provisioningLog: provisioningLogRepository
      ? await prune(policy.provisioningLogMs, now, (c) =>
          provisioningLogRepository.deleteOlderThan(c),
        )
      : 0,
    // Reset tokens past their own expiry — `now`, not a window.
    passwordResetTokens: passwordResetTokenRepository
      ? await passwordResetTokenRepository.deleteExpired(now)
      : 0,
  }
}
