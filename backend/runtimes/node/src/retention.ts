import type {
  AgentContextSnapshotRepository,
  BinaryArtifactStore,
  Clock,
  LlmCallMetricRepository,
  PasswordResetTokenRepository,
  PipelineScheduleRepository,
  ProvisioningLogRepository,
  SubscriptionActivationRepository,
  TokenUsageRepository,
  WorkspaceRepository,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import { DEFAULT_WORKSPACE_SETTINGS } from '@cat-factory/kernel'
import { sweepBinaryArtifactRetention } from '@cat-factory/orchestration'
import type { Logger, RetentionConfig } from '@cat-factory/server'

/** Recurring-pipeline run history is kept ~1 week (the inspector's window). */
export const SCHEDULE_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

// Retention sweep for the Node facade's unbounded tables. The Worker prunes these from
// its every-2-min cron (see the Worker's `sweepRetention`); the Node service has no
// cron, so a timer mirrors it. Node persists two of the retention-eligible tables today
// — the append-only `token_usage` ledger and the heavy `llm_call_metrics` observability
// sink (full per-call prompt/response). The GitHub rate-limit/commit projections are not
// wired on Node yet, so there is nothing to prune for them. Each table is pruned to its
// configured age window; a non-positive window disables that pass, matching the Worker.

/** The Node-persisted repositories with an age-based prune. */
export interface RetentionRepos {
  tokenUsageRepository: Pick<TokenUsageRepository, 'deleteOlderThan'>
  llmCallMetricRepository: Pick<LlmCallMetricRepository, 'deleteOlderThan'>
  // The agent-context observability sink rides the same window as llmCallMetrics.
  agentContextSnapshotRepository: Pick<AgentContextSnapshotRepository, 'deleteOlderThan'>
  pipelineScheduleRepository: Pick<PipelineScheduleRepository, 'pruneRunsBefore'>
  // Personal-credential per-run activations whose TTL has passed (individual-usage
  // subscriptions). Mirrors the Worker's activation-sweeper cron.
  subscriptionActivationRepository: Pick<SubscriptionActivationRepository, 'deleteExpired'>
  // High-churn provisioning event log (its own Postgres schema); always wired on Node.
  provisioningLogRepository: Pick<ProvisioningLogRepository, 'deleteOlderThan'>
  // Password-reset tokens past their own TTL (single-use + 1h expiry, so tiny).
  passwordResetTokenRepository: Pick<PasswordResetTokenRepository, 'deleteExpired'>
}

/** Rows reclaimed from each table, for logging. */
export interface RetentionResult {
  tokenUsage: number
  llmCallMetrics: number
  agentContextSnapshots: number
  scheduleRuns: number
  activations: number
  provisioningLog: number
  passwordResetTokens: number
}

/**
 * How often the retention sweep runs. The windows are measured in days, so an hourly
 * pass keeps the tables bounded at negligible cost — each prune is an indexed range
 * delete that usually reclaims nothing.
 */
export const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000

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
 * Prune each Node-persisted unbounded table to its retention window. Pure over its
 * repos so it is unit-testable without a database (mirrors the Worker's pure
 * `sweepRetention`). Returns the counts removed per table.
 */
export async function sweepRetention(
  repos: RetentionRepos,
  retention: RetentionConfig,
  now: number,
): Promise<RetentionResult> {
  return {
    tokenUsage: await prune(retention.tokenUsageMs, now, (c) =>
      repos.tokenUsageRepository.deleteOlderThan(c),
    ),
    llmCallMetrics: await prune(retention.llmCallMetricsMs, now, (c) =>
      repos.llmCallMetricRepository.deleteOlderThan(c),
    ),
    // Same window as the LLM call telemetry: heavy prompt + injected-file bodies.
    agentContextSnapshots: await prune(retention.llmCallMetricsMs, now, (c) =>
      repos.agentContextSnapshotRepository.deleteOlderThan(c),
    ),
    // Fixed ~1-week window (not part of the configurable retention policy).
    scheduleRuns: await prune(SCHEDULE_RUN_RETENTION_MS, now, (c) =>
      repos.pipelineScheduleRepository.pruneRunsBefore(c),
    ),
    // Delete activations whose own TTL (expires_at) has passed — `now`, not a window.
    activations: await repos.subscriptionActivationRepository.deleteExpired(now),
    provisioningLog: await prune(retention.provisioningLogMs, now, (c) =>
      repos.provisioningLogRepository.deleteOlderThan(c),
    ),
    // Reset tokens past their own expiry — `now`, not a window (like activations).
    passwordResetTokens: await repos.passwordResetTokenRepository.deleteExpired(now),
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
): () => void {
  const tick = async () => {
    try {
      const {
        tokenUsage,
        llmCallMetrics,
        agentContextSnapshots,
        scheduleRuns,
        activations,
        provisioningLog,
        passwordResetTokens,
      } = await sweepRetention(repos, retention, clock.now())
      if (
        tokenUsage > 0 ||
        llmCallMetrics > 0 ||
        agentContextSnapshots > 0 ||
        scheduleRuns > 0 ||
        activations > 0 ||
        provisioningLog > 0 ||
        passwordResetTokens > 0
      ) {
        log.info(
          {
            tokenUsage,
            llmCallMetrics,
            agentContextSnapshots,
            scheduleRuns,
            activations,
            provisioningLog,
            passwordResetTokens,
          },
          'retention sweep reclaimed rows',
        )
      }
    } catch (error) {
      log.error(
        { err: error instanceof Error ? error.message : String(error) },
        'retention sweep failed',
      )
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), RETENTION_SWEEP_INTERVAL_MS)
  timer.unref?.() // never keep the process alive on the sweep timer alone
  return () => clearInterval(timer)
}

/**
 * Start the per-workspace binary-artifact retention sweep (the Node analogue of the Worker's
 * artifact-retention cron). Unlike the global ledger sweep above, retention here is a
 * per-workspace setting, so each tick iterates workspaces and prunes each one's screenshots +
 * reference images — bytes and metadata — past its own `artifactRetentionDays` window. Runs
 * once immediately then hourly; best-effort. Returns a stop function.
 */
export function startArtifactRetentionSweeper(
  store: Pick<BinaryArtifactStore, 'pruneOlderThan'>,
  workspaceRepository: Pick<WorkspaceRepository, 'listVisible'>,
  settingsRepository: Pick<WorkspaceSettingsRepository, 'get'>,
  clock: Clock,
  log: Logger,
): () => void {
  const tick = async () => {
    try {
      const removed = await sweepBinaryArtifactRetention({
        store,
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
        log.info({ binaryArtifacts: removed }, 'artifact retention sweep reclaimed rows')
    } catch (error) {
      log.error(
        { err: error instanceof Error ? error.message : String(error) },
        'artifact retention sweep failed',
      )
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), RETENTION_SWEEP_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
