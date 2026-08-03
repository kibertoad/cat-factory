import type { Clock, Logger } from '@cat-factory/kernel'
import { startSweeper } from '@cat-factory/node-server'
import type { RetentionConfig } from '@cat-factory/server'
import type { LocalTelemetryStore } from './sqlite/telemetryStore.js'

// Retention for the mothership-mode LOCAL telemetry store (docs/initiatives/mothership-mode.md,
// PR 5). Telemetry is local-first on a mothership-mode node, so nothing else prunes it: the
// mothership's own cron owns ITS tables, and the Node facade's `startRetentionSweeper` runs from
// `start()`, which a mothership-mode boot never calls (there is no Postgres and no pg-boss). Left
// unpruned, the `llm_call_metrics` table — full per-call prompt + response bodies — grows without
// bound on the developer's disk, which is exactly the failure the configured window exists to
// prevent on the other two runtimes.
//
// The windows are the SAME `RetentionConfig` the Node/Worker sweeps use, so a developer's laptop
// keeps telemetry for as long as the deployment says. Only the tables this store actually owns are
// pruned; everything else on a mothership-mode node is org state the mothership prunes.

/**
 * How often the local telemetry prune runs. Matches the Node facade's retention cadence: the
 * windows are measured in days, so an hourly indexed range delete costs nothing and usually
 * reclaims nothing.
 */
const LOCAL_TELEMETRY_SWEEP_INTERVAL_MS = 60 * 60 * 1000

/**
 * Idle quota-cycle rows are pruned after a fixed 30 days, deliberately far beyond the longest
 * quota window (the 7-day weekly one) so a live cycle is never deleted mid-window. Mirrors the
 * Node facade's `SUBSCRIPTION_QUOTA_CYCLE_RETENTION_MS`; a stale window re-anchors on next use.
 */
const SUBSCRIPTION_QUOTA_CYCLE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** Rows reclaimed from each local telemetry table, for logging. */
export interface LocalTelemetryRetentionResult {
  llmCallMetrics: number
  agentContextSnapshots: number
  agentSearchQueries: number
  provisioningLog: number
  subscriptionQuotaCycles: number
  /** Upstream-ingest high-water marks (PR 5's sync UP) whose runs' rows are long gone. */
  ingestState: number
  /** Partial-prune markers (PR 5's read-through) for runs the store now holds nothing of. */
  prunedRunMarkers: number
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
 * Prune each local telemetry table to its retention window. Pure over the store, so it is
 * unit-testable without a timer (mirrors the Node facade's `sweepRetention`). The three
 * agent-observability sinks share the LLM-call window — they are the same run's heavy bodies —
 * while the provisioning log keeps its own and the quota cycles a fixed one.
 */
export async function sweepLocalTelemetryRetention(
  store: LocalTelemetryStore,
  retention: RetentionConfig,
  now: number,
): Promise<LocalTelemetryRetentionResult> {
  return {
    llmCallMetrics: await prune(retention.llmCallMetricsMs, now, (c) =>
      store.llmCallMetricRepository.deleteOlderThan(c),
    ),
    agentContextSnapshots: await prune(retention.llmCallMetricsMs, now, (c) =>
      store.agentContextSnapshotRepository.deleteOlderThan(c),
    ),
    agentSearchQueries: await prune(retention.llmCallMetricsMs, now, (c) =>
      store.agentSearchQueryRepository.deleteOlderThan(c),
    ),
    provisioningLog: await prune(retention.provisioningLogMs, now, (c) =>
      store.provisioningLogRepository.deleteOlderThan(c),
    ),
    subscriptionQuotaCycles: await prune(SUBSCRIPTION_QUOTA_CYCLE_RETENTION_MS, now, (c) =>
      store.subscriptionQuotaCycleRepository.deleteOlderThan(c),
    ),
    // The ingest bookkeeping rides the LLM-call window too, and the ordering is what makes that
    // safe: a mark is stamped at ingest time, which is always at or after the newest row it covers,
    // so the mark outlives the rows it describes and can never be dropped while a still-stored run
    // would be re-uploaded because of it.
    ingestState: await prune(retention.llmCallMetricsMs, now, async (c) =>
      store.ingestReader.deleteIngestStateOlderThan(c),
    ),
    // LAST, and unconditionally: the three prunes above are what create these markers, so sweeping
    // before them would leave a pass's own markers behind for an hour. It takes no window of its
    // own — a marker is spent exactly when the run it names has no local rows left, at which point
    // the read-through's emptiness gate already falls through to the mothership. Ageing it out on
    // a duration instead would expire it while the run's SURVIVING rows were still being answered
    // with, which is the one moment it is load-bearing.
    prunedRunMarkers: store.coverage.forgetSettledRuns(),
  }
}

/**
 * Start the periodic local telemetry prune. Runs once immediately (so a restart reclaims promptly)
 * then hourly, non-overlapping and best-effort — a failed pass is logged and retried next tick,
 * never thrown, because losing observability must never take the node down.
 *
 * The returned stop function is ASYNC and must be AWAITED before the store is closed. That is not
 * tidiness: the immediate first pass is asynchronous, so on a short-lived node (a test, a boot that
 * fails straight after) it is still mid-flight when shutdown closes the SQLite handle underneath
 * it — the pass then dies on "database is not open" and every such exit carries a spurious error
 * line. Awaiting the in-flight pass makes teardown ordered instead of racy; the stop flag covers
 * the case where the pass has not started yet.
 */
export function startLocalTelemetryRetention(
  store: LocalTelemetryStore,
  retention: RetentionConfig,
  clock: Clock,
  log: Logger,
): () => Promise<void> {
  let stopped = false
  let inFlight: Promise<unknown> | undefined
  const stopSweeper = startSweeper({
    name: 'local-telemetry-retention',
    intervalMs: LOCAL_TELEMETRY_SWEEP_INTERVAL_MS,
    log,
    failureMessage: 'local telemetry retention sweep failed',
    tick: async () => {
      if (stopped) return
      const pass = sweepLocalTelemetryRetention(store, retention, clock.now())
      inFlight = pass
      try {
        const reclaimed = await pass
        if (Object.values(reclaimed).some((n) => n > 0)) {
          log.info('local telemetry retention sweep reclaimed rows', { ...reclaimed })
        }
      } finally {
        if (inFlight === pass) inFlight = undefined
      }
    },
  })
  return async () => {
    stopped = true
    stopSweeper()
    // silent-catch-ok: the sweeper's own error handler already logged this pass's failure; here we
    // only need it to have FINISHED touching the store before the caller closes it, so re-reporting
    // would duplicate the line and rethrowing would fail an otherwise clean shutdown.
    await inFlight?.catch(() => undefined)
  }
}
