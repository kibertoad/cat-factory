import type { Clock, LlmCallMetricRepository, TokenUsageRepository } from '@cat-factory/kernel'
import type { Logger, RetentionConfig } from '@cat-factory/server'

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
}

/** Rows reclaimed from each table, for logging. */
export interface RetentionResult {
  tokenUsage: number
  llmCallMetrics: number
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
      const { tokenUsage, llmCallMetrics } = await sweepRetention(repos, retention, clock.now())
      if (tokenUsage > 0 || llmCallMetrics > 0) {
        log.info({ tokenUsage, llmCallMetrics }, 'retention sweep reclaimed rows')
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
