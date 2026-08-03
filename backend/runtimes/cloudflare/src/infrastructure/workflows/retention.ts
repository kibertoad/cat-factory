import type {
  AgentContextSnapshotRepository,
  AgentSearchQueryRepository,
  Clock,
  CommitProjectionRepository,
  LlmCallMetricRepository,
  GateOutcomeRepository,
  NotificationRepository,
  PasswordResetTokenRepository,
  PlatformMetricsRepository,
  PipelineScheduleRepository,
  ProvisioningLogRepository,
  RateLimitRepository,
  SubscriptionQuotaCycleRepository,
  TokenUsageRepository,
  Logger,
} from '@cat-factory/kernel'
import { RUN_DAY_ROLLUP_LOOKBACK_MS, createRetentionPass } from '@cat-factory/orchestration'

/** Recurring-pipeline run history is kept ~1 week (the inspector's window). */
const SCHEDULE_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Idle subscription quota-cycle rows are pruned after 30 days. A fixed window (not the
 * configurable retention policy), deliberately far beyond the longest quota window (the
 * 7-day weekly one) so a live cycle is never deleted mid-window — a row untouched for
 * 30 days has long since reset and only holds stale counters.
 */
const SUBSCRIPTION_QUOTA_CYCLE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

// Retention sweep for the tables that don't self-limit (see
// docs/storage-and-retention.md): the append-only `token_usage` ledger, the
// `github_rate_limits` telemetry, and the `github_commits` projection. Cron
// invokes this alongside the run sweeper; each table is pruned to its configured
// age window. Pure orchestration over its ports so it is unit-testable with the
// real D1 repositories (mirroring the execution sweeper's style).

/** Per-table retention ages in milliseconds; 0 (or less) disables that table's pass. */
interface RetentionPolicy {
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
  /** Resolved (acted/dismissed) notifications; open cards are never pruned. */
  notificationsMs: number
  /** Settled-gate projection (`gate_outcomes`) behind the dashboard's attempt statistics. */
  gateOutcomesMs: number
  /** Daily run rollup (`platform_run_days`) behind the `30d` / `90d` dashboard windows. */
  runDaysMs: number
}

export interface RetentionDeps {
  tokenUsageRepository: TokenUsageRepository
  rateLimitRepository: RateLimitRepository
  commitRepository: CommitProjectionRepository
  llmCallMetricRepository: LlmCallMetricRepository
  /** Agent-context snapshots; pruned on the same window as the LLM call telemetry. */
  agentContextSnapshotRepository: AgentContextSnapshotRepository
  /** Agent-search queries; pruned on the same window as the LLM call telemetry. */
  agentSearchQueryRepository: AgentSearchQueryRepository
  /** Idle modeled subscription quota-cycle counters, pruned to a fixed 30-day window. */
  subscriptionQuotaCycleRepository: SubscriptionQuotaCycleRepository
  /** Optional: prunes recurring-pipeline run history to {@link SCHEDULE_RUN_RETENTION_MS}. */
  pipelineScheduleRepository?: PipelineScheduleRepository
  /** Optional: the provisioning event log (only when the PROVISIONING_DB binding is present). */
  provisioningLogRepository?: ProvisioningLogRepository
  /** Optional: password-reset tokens past their own TTL (single-use + 1h expiry). */
  passwordResetTokenRepository?: PasswordResetTokenRepository
  /** Resolved notifications past the retention window (open cards are never pruned). */
  notificationRepository: NotificationRepository
  /** Settled-gate projection: pruned to `gateOutcomesMs`. */
  gateOutcomeRepository: GateOutcomeRepository
  /**
   * The daily run rollup: this pass both MATERIALISES it (a short trailing window, so a missed
   * pass self-heals) and prunes it to `runDaysMs`.
   */
  platformMetricsRepository: PlatformMetricsRepository
  clock: Clock
  policy: RetentionPolicy
  /** Names the table behind each isolated prune failure. Absent ⇒ the failures are silent. */
  logger?: Logger
}

/** Rows reclaimed from each table, plus the tables the pass could not prune. */
export interface RetentionResult {
  tokenUsage: number
  rateLimits: number
  commits: number
  llmCallMetrics: number
  agentContextSnapshots: number
  agentSearchQueries: number
  subscriptionQuotaCycles: number
  scheduleRuns: number
  provisioningLog: number
  passwordResetTokens: number
  notifications: number
  gateOutcomes: number
  runDays: number
  /** Daily buckets (re)written by this pass's rollup: a WRITE, not rows reclaimed. */
  runDaysRolledUp: number
  /**
   * The tables whose prune threw this pass. EMPTY on a clean pass. Reported separately from
   * the counts because a failed prune and an empty table both reclaim 0 rows, and only one of
   * them means the table is still growing.
   */
  failedTables: string[]
}

/**
 * Prune each unbounded table to its retention window. The deletes are
 * range-scans on indexed columns and usually reclaim nothing, so this is cheap
 * to run on the every-2-min cron. Returns the counts removed per table plus the tables that
 * failed.
 *
 * Every table is pruned in ISOLATION (slice 4.4): the passes used to be a chain of bare
 * `await`s, so the first failing `deleteOlderThan` aborted every later one — indefinitely,
 * since the same table failed on every subsequent pass too. Shared with the Node twin via
 * `createRetentionPass`, so the two facades cannot drift on it.
 */
export async function sweepRetention({
  tokenUsageRepository,
  rateLimitRepository,
  commitRepository,
  llmCallMetricRepository,
  agentContextSnapshotRepository,
  agentSearchQueryRepository,
  subscriptionQuotaCycleRepository,
  pipelineScheduleRepository,
  provisioningLogRepository,
  passwordResetTokenRepository,
  notificationRepository,
  gateOutcomeRepository,
  platformMetricsRepository,
  clock,
  policy,
  logger,
}: RetentionDeps): Promise<RetentionResult> {
  const now = clock.now()
  const pass = createRetentionPass(logger)
  return {
    tokenUsage: await pass.prune('token_usage', policy.tokenUsageMs, now, (c) =>
      tokenUsageRepository.deleteOlderThan(c),
    ),
    rateLimits: await pass.prune('github_rate_limits', policy.rateLimitMs, now, (c) =>
      rateLimitRepository.deleteOlderThan(c),
    ),
    commits: await pass.prune('github_commits', policy.commitMs, now, (c) =>
      commitRepository.deleteOlderThan(c),
    ),
    llmCallMetrics: await pass.prune('llm_call_metrics', policy.llmCallMetricsMs, now, (c) =>
      llmCallMetricRepository.deleteOlderThan(c),
    ),
    // Same window as the LLM call telemetry (heavy prompt + injected-file bodies).
    agentContextSnapshots: await pass.prune(
      'agent_context_snapshots',
      policy.llmCallMetricsMs,
      now,
      (c) => agentContextSnapshotRepository.deleteOlderThan(c),
    ),
    // Same window as the LLM call telemetry (performed web-search queries).
    agentSearchQueries: await pass.prune(
      'agent_search_queries',
      policy.llmCallMetricsMs,
      now,
      (c) => agentSearchQueryRepository.deleteOlderThan(c),
    ),
    // Idle quota cycles past the fixed 30-day window (well beyond the weekly one).
    subscriptionQuotaCycles: await pass.prune(
      'subscription_quota_cycles',
      SUBSCRIPTION_QUOTA_CYCLE_RETENTION_MS,
      now,
      (c) => subscriptionQuotaCycleRepository.deleteOlderThan(c),
    ),
    scheduleRuns: pipelineScheduleRepository
      ? await pass.prune('pipeline_schedule_runs', SCHEDULE_RUN_RETENTION_MS, now, (c) =>
          pipelineScheduleRepository.pruneRunsBefore(c),
        )
      : 0,
    provisioningLog: provisioningLogRepository
      ? await pass.prune('provisioning_log', policy.provisioningLogMs, now, (c) =>
          provisioningLogRepository.deleteOlderThan(c),
        )
      : 0,
    // Reset tokens past their own expiry — `now`, not a window.
    passwordResetTokens: passwordResetTokenRepository
      ? await pass.expire('password_reset_tokens', () =>
          passwordResetTokenRepository.deleteExpired(now),
        )
      : 0,
    // Resolved (acted/dismissed) notifications past the window; open cards untouched.
    notifications: await pass.prune('notifications', policy.notificationsMs, now, (c) =>
      notificationRepository.deleteResolvedOlderThan(c),
    ),
    // Settled gates behind the dashboard's attempt statistics.
    gateOutcomes: await pass.prune('gate_outcomes', policy.gateOutcomesMs, now, (c) =>
      gateOutcomeRepository.deleteOlderThan(c),
    ),
    // Materialise the daily rollup BEFORE pruning it, so a pass never prunes a window it is
    // about to rewrite, and recompute a short trailing lookback so a missed pass self-heals
    // rather than leaving a day permanently half-counted.
    runDaysRolledUp: await pass.materialize('platform_run_days', () =>
      platformMetricsRepository.rollupRunDays(now - RUN_DAY_ROLLUP_LOOKBACK_MS, now),
    ),
    runDays: await pass.prune('platform_run_days', policy.runDaysMs, now, (c) =>
      platformMetricsRepository.deleteRunDaysOlderThan(c),
    ),
    failedTables: pass.failed,
  }
}
