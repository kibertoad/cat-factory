import type {
  AgentContextSnapshotRepository,
  AgentSearchQueryRepository,
  AgentToolCallRepository,
  ResolveBinaryArtifactStore,
  Clock,
  CommitProjectionRepository,
  GateOutcomeRepository,
  LlmCallMetricRepository,
  NotificationRepository,
  AuthAttemptRepository,
  MachineNodeRepository,
  PasswordResetTokenRepository,
  PipelineScheduleRepository,
  PlatformMetricsRepository,
  ProvisioningLogRepository,
  SpendRollupRepository,
  SubscriptionActivationRepository,
  SubscriptionQuotaCycleRepository,
  TokenUsageRepository,
  WorkspaceRepository,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import { DEFAULT_WORKSPACE_SETTINGS } from '@cat-factory/kernel'
import {
  RUN_DAY_ROLLUP_LOOKBACK_MS,
  createRetentionPass,
  spendRollupWindow,
  sweepBinaryArtifactRetention,
} from '@cat-factory/orchestration'
import type { Logger, RetentionConfig, SweepHealthTracker } from '@cat-factory/server'
import { startSweeper } from './sweeper.js'

/** Recurring-pipeline run history is kept ~1 week (the inspector's window). */
const SCHEDULE_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

// Auth attempts are junk once the 15-minute throttle window closes; a 1-hour retention
// leaves ample slack for clock skew while keeping the hot (key, at) index tiny.
const AUTH_ATTEMPT_RETENTION_MS = 60 * 60 * 1000

/**
 * Idle subscription quota-cycle rows are pruned after 30 days. A fixed window (not the
 * configurable retention policy), deliberately far beyond the longest quota window (the
 * 7-day weekly one) so a live cycle is never deleted mid-window — a row untouched for
 * 30 days has long since reset and only holds stale counters.
 */
const SUBSCRIPTION_QUOTA_CYCLE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

// Retention sweep for the Node facade's unbounded tables. The Worker prunes these from
// its every-2-min cron (see the Worker's `sweepRetention`); the Node service has no
// cron, so a timer mirrors it. This covers the append-only `token_usage` ledger, the
// heavy `llm_call_metrics` observability sink (full per-call prompt/response), and the
// `github_commits` projection (webhook/backfill-fed whenever the GitHub App is wired —
// without a prune it grows without bound, exactly what `retention.commitMs` bounds on
// the Worker). The rate-limit ledger is a Noop on Node (an intentional telemetry
// omission), so it alone has nothing to prune. Each table is pruned to its configured
// age window; a non-positive window disables that pass, matching the Worker.

/** The Node-persisted repositories with an age-based prune. */
export interface RetentionRepos {
  tokenUsageRepository: Pick<TokenUsageRepository, 'deleteOlderThan'>
  llmCallMetricRepository: Pick<LlmCallMetricRepository, 'deleteOlderThan'>
  // The agent-context observability sink rides the same window as llmCallMetrics.
  agentContextSnapshotRepository: Pick<AgentContextSnapshotRepository, 'deleteOlderThan'>
  // The agent-search-query sink rides the same window as llmCallMetrics.
  agentSearchQueryRepository: Pick<AgentSearchQueryRepository, 'deleteOlderThan'>
  // The tool-call trajectory sink rides the same window as llmCallMetrics.
  agentToolCallRepository: Pick<AgentToolCallRepository, 'deleteOlderThan'>
  pipelineScheduleRepository: Pick<PipelineScheduleRepository, 'pruneRunsBefore'>
  // Personal-credential per-run activations whose TTL has passed (individual-usage
  // subscriptions). Mirrors the Worker's activation-sweeper cron.
  subscriptionActivationRepository: Pick<SubscriptionActivationRepository, 'deleteExpired'>
  // Idle modeled subscription quota-cycle counters, pruned to a fixed 30-day window.
  subscriptionQuotaCycleRepository: Pick<SubscriptionQuotaCycleRepository, 'deleteOlderThan'>
  // High-churn provisioning event log (its own Postgres schema); always wired on Node.
  provisioningLogRepository: Pick<ProvisioningLogRepository, 'deleteOlderThan'>
  // Password-reset tokens past their own TTL (single-use + 1h expiry, so tiny).
  passwordResetTokenRepository: Pick<PasswordResetTokenRepository, 'deleteExpired'>
  // Machine-node roster rows past their latest signed exp (no token for the node can
  // outlive it, so a revocation tombstone past it protects nothing).
  machineNodeRepository: Pick<MachineNodeRepository, 'deleteExpired'>
  // Password-throttle attempts (SEC-4), junk minutes after the window closes.
  authAttemptRepository: Pick<AuthAttemptRepository, 'deleteOlderThan'>
  // The GitHub commit projection (`github_commits`), pruned to `retention.commitMs`
  // like the Worker's daily prune. Fed only when the GitHub App is configured, but the
  // prune is wired unconditionally — on an unwired deployment the table is empty and
  // the pass is a free no-op.
  commitRepository: Pick<CommitProjectionRepository, 'deleteOlderThan'>
  // Resolved (acted/dismissed) notifications past the retention window. Open cards (the
  // actionable inbox) are never pruned.
  notificationRepository: Pick<NotificationRepository, 'deleteResolvedOlderThan'>
  // The settled-gate projection behind the dashboard's gate / CI-fixer attempt statistics.
  gateOutcomeRepository: Pick<GateOutcomeRepository, 'deleteOlderThan'>
  // The daily run rollup: this pass both MATERIALISES it and bounds it.
  platformMetricsRepository: Pick<
    PlatformMetricsRepository,
    'rollupRunDays' | 'deleteRunDaysOlderThan'
  >
  // The durable cost-attribution rollup. This pass only WRITES it: `spend_days` has no
  // prune, here or on the Worker, and no `deleteOlderThan` on its port to call. A TCO table
  // that expires is just a slower ledger.
  spendRollupRepository: Pick<SpendRollupRepository, 'rollupSpendDays' | 'spendRollupWatermark'>
}

/** Rows reclaimed from each table, plus the tables the pass could not prune. */
export interface RetentionResult {
  tokenUsage: number
  llmCallMetrics: number
  agentContextSnapshots: number
  agentSearchQueries: number
  agentToolCalls: number
  scheduleRuns: number
  activations: number
  subscriptionQuotaCycles: number
  provisioningLog: number
  passwordResetTokens: number
  machineNodes: number
  authAttempts: number
  commits: number
  notifications: number
  gateOutcomes: number
  runDays: number
  /** Daily buckets (re)written by this pass's rollup: a WRITE, not rows reclaimed. */
  runDaysRolledUp: number
  /** Durable cost-attribution buckets (re)written by this pass: a WRITE, never a prune. */
  spendDaysRolledUp: number
  /**
   * The tables whose prune threw this pass. EMPTY on a clean pass. Reported separately from
   * the counts because a failed prune and an empty table both reclaim 0 rows, and only one of
   * them means the table is still growing.
   */
  failedTables: string[]
}

/**
 * How often the retention sweep runs. The windows are measured in days, so an hourly
 * pass keeps the tables bounded at negligible cost — each prune is an indexed range
 * delete that usually reclaims nothing.
 */
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000

/**
 * Prune each Node-persisted unbounded table to its retention window. Pure over its
 * repos so it is unit-testable without a database (mirrors the Worker's pure
 * `sweepRetention`). Returns the counts removed per table plus the tables that failed.
 *
 * Every table is pruned in ISOLATION (slice 4.4): the passes used to be a chain of bare
 * `await`s, so the first failing `deleteOlderThan` aborted every later one — indefinitely,
 * since the same table failed on every subsequent pass too. The heaviest tables
 * (`llm_call_metrics`, the agent-context snapshots) sit late in the chain, which made that
 * the worst possible ordering. Shared with the Worker's twin via `createRetentionPass`.
 */
export async function sweepRetention(
  repos: RetentionRepos,
  retention: RetentionConfig,
  now: number,
  logger?: Logger,
): Promise<RetentionResult> {
  const pass = createRetentionPass(logger)
  return {
    // FIRST, and before the ledger prune below: the durable rollup folds `token_usage`, so a
    // pass that pruned first would drop spend that had never been rolled up. It resumes from
    // its own watermark rather than a fixed lookback, because a day missed here is missing
    // from the only durable record of it, permanently. See `spendRollupWindow`.
    spendDaysRolledUp: await pass.materialize('spend_days', async () => {
      const watermark = await repos.spendRollupRepository.spendRollupWatermark()
      const { from, to } = spendRollupWindow(watermark, now)
      return repos.spendRollupRepository.rollupSpendDays(from, to)
    }),
    tokenUsage: await pass.prune('token_usage', retention.tokenUsageMs, now, (c) =>
      repos.tokenUsageRepository.deleteOlderThan(c),
    ),
    llmCallMetrics: await pass.prune('llm_call_metrics', retention.llmCallMetricsMs, now, (c) =>
      repos.llmCallMetricRepository.deleteOlderThan(c),
    ),
    // Same window as the LLM call telemetry: heavy prompt + injected-file bodies.
    agentContextSnapshots: await pass.prune(
      'agent_context_snapshots',
      retention.llmCallMetricsMs,
      now,
      (c) => repos.agentContextSnapshotRepository.deleteOlderThan(c),
    ),
    // Same window as the LLM call telemetry (performed web-search queries).
    agentSearchQueries: await pass.prune(
      'agent_search_queries',
      retention.llmCallMetricsMs,
      now,
      (c) => repos.agentSearchQueryRepository.deleteOlderThan(c),
    ),
    // Same window as the LLM call telemetry (the tool-call trajectory's captured bodies).
    agentToolCalls: await pass.prune('agent_tool_calls', retention.llmCallMetricsMs, now, (c) =>
      repos.agentToolCallRepository.deleteOlderThan(c),
    ),
    // Fixed ~1-week window (not part of the configurable retention policy).
    scheduleRuns: await pass.prune('pipeline_schedule_runs', SCHEDULE_RUN_RETENTION_MS, now, (c) =>
      repos.pipelineScheduleRepository.pruneRunsBefore(c),
    ),
    // Delete activations whose own TTL (expires_at) has passed — `now`, not a window.
    activations: await pass.expire('subscription_activations', () =>
      repos.subscriptionActivationRepository.deleteExpired(now),
    ),
    // Idle quota cycles past the fixed 30-day window (well beyond the weekly one).
    subscriptionQuotaCycles: await pass.prune(
      'subscription_quota_cycles',
      SUBSCRIPTION_QUOTA_CYCLE_RETENTION_MS,
      now,
      (c) => repos.subscriptionQuotaCycleRepository.deleteOlderThan(c),
    ),
    provisioningLog: await pass.prune('provisioning_log', retention.provisioningLogMs, now, (c) =>
      repos.provisioningLogRepository.deleteOlderThan(c),
    ),
    // Reset tokens past their own expiry — `now`, not a window (like activations).
    passwordResetTokens: await pass.expire('password_reset_tokens', () =>
      repos.passwordResetTokenRepository.deleteExpired(now),
    ),
    // Machine-node roster rows past their latest signed exp: `now`, not a window.
    machineNodes: await pass.expire('machine_nodes', () =>
      repos.machineNodeRepository.deleteExpired(now),
    ),
    // Password-throttle attempts on a fixed aggressive window (SEC-4).
    authAttempts: await pass.prune('auth_attempts', AUTH_ATTEMPT_RETENTION_MS, now, (c) =>
      repos.authAttemptRepository.deleteOlderThan(c),
    ),
    commits: await pass.prune('github_commits', retention.commitMs, now, (c) =>
      repos.commitRepository.deleteOlderThan(c),
    ),
    // Resolved (acted/dismissed) notifications past the window; open cards untouched.
    notifications: await pass.prune('notifications', retention.notificationsMs, now, (c) =>
      repos.notificationRepository.deleteResolvedOlderThan(c),
    ),
    // Settled gates behind the dashboard's attempt statistics.
    gateOutcomes: await pass.prune('gate_outcomes', retention.gateOutcomesMs, now, (c) =>
      repos.gateOutcomeRepository.deleteOlderThan(c),
    ),
    // Materialise the daily rollup BEFORE pruning it, so a pass never prunes a window it is
    // about to rewrite, and recompute a short trailing lookback so a missed pass self-heals
    // rather than leaving a day permanently half-counted.
    runDaysRolledUp: await pass.materialize('platform_run_days', () =>
      repos.platformMetricsRepository.rollupRunDays(now - RUN_DAY_ROLLUP_LOOKBACK_MS, now),
    ),
    runDays: await pass.prune('platform_run_days', retention.runDaysMs, now, (c) =>
      repos.platformMetricsRepository.deleteRunDaysOlderThan(c),
    ),
    failedTables: pass.failed,
  }
}

/**
 * Start the periodic retention sweep, the Node analogue of the Worker's cron prune.
 * Runs once immediately (so a restart reclaims promptly) then on an hourly timer.
 * Best-effort: a failed sweep is logged and retried next tick, never thrown. Returns
 * a stop function that clears the timer.
 */
export function startRetentionSweeper(
  repos: RetentionRepos,
  retention: RetentionConfig,
  clock: Clock,
  log: Logger,
  /** Records each pass's outcome under this sweep's name (see {@link startSweeper}). */
  health: SweepHealthTracker,
): () => void {
  return startSweeper({
    name: 'retention',
    intervalMs: RETENTION_SWEEP_INTERVAL_MS,
    log,
    health,
    failureMessage: 'retention sweep failed',
    tick: async () => {
      const { failedTables, ...reclaimed } = await sweepRetention(
        repos,
        retention,
        clock.now(),
        log,
      )
      if (Object.values(reclaimed).some((n) => n > 0)) {
        log.info('retention sweep reclaimed rows', { ...reclaimed })
      }
      // Each failure was already warned at its table; this names the SET, so "one table has
      // been failing every hour for a week" is one greppable line rather than a pattern
      // someone has to notice across hundreds.
      if (failedTables.length > 0) {
        log.warn('retention sweep could not prune every table', { failedTables })
      }
    },
  })
}

/**
 * Start the per-workspace binary-artifact retention sweep (the Node analogue of the Worker's
 * artifact-retention cron). Unlike the global ledger sweep above, retention here is a
 * per-workspace setting, so each tick iterates workspaces and prunes each one's screenshots +
 * reference images — bytes and metadata — past its own `artifactRetentionDays` window. Runs
 * once immediately then hourly; best-effort. Returns a stop function.
 */
export function startArtifactRetentionSweeper(
  resolveStore: ResolveBinaryArtifactStore,
  workspaceRepository: Pick<WorkspaceRepository, 'listVisible'>,
  settingsRepository: Pick<WorkspaceSettingsRepository, 'get'>,
  clock: Clock,
  log: Logger,
  /** Records each pass's outcome under this sweep's name (see {@link startSweeper}). */
  health: SweepHealthTracker,
): () => void {
  return startSweeper({
    name: 'artifact-retention',
    intervalMs: RETENTION_SWEEP_INTERVAL_MS,
    log,
    health,
    failureMessage: 'artifact retention sweep failed',
    tick: async () => {
      const removed = await sweepBinaryArtifactRetention({
        resolveStore,
        listWorkspaceIds: () =>
          workspaceRepository.listVisible(null).then((ws) => ws.map((w) => w.id)),
        retentionDaysFor: (workspaceId) =>
          settingsRepository
            .get(workspaceId)
            .then(
              (s) => s?.artifactRetentionDays ?? DEFAULT_WORKSPACE_SETTINGS.artifactRetentionDays,
            ),
        now: clock.now(),
      })
      if (removed > 0)
        log.info('artifact retention sweep reclaimed rows', { binaryArtifacts: removed })
    },
  })
}
