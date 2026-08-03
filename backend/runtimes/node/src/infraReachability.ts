import type { Clock, OperationalMetrics } from '@cat-factory/kernel'
import { type Logger, type ServerContainer, sweepInfraReachability } from '@cat-factory/server'
import { startSweeper } from './sweeper.js'

// Periodic infrastructure-REACHABILITY watcher for the Node facade — the analogue of the Worker's
// every-2-min cron call to `sweepInfraReachability`. It probes each workspace's CONFIGURED
// infrastructure connections and reports a dead one as `unreachable` (raising an
// `infra_unreachable` notification and pushing an `infraSetup` event on each transition). The Node
// service has no cron, so a timer drives it (interval from `INFRA_REACHABILITY_INTERVAL_MS`,
// default 5min). No-op unless `INFRA_REACHABILITY_WATCH` is opted in AND the notifications module
// plus at least one probeable integration are wired (the sweep itself is a further no-op when they
// aren't). Kept symmetric with the Worker via the SAME shared driver.

/**
 * Start the periodic reachability watcher. Runs once immediately then on the interval,
 * non-overlapping + best-effort (see {@link startSweeper}). A NO-OP (returns a no-op stop) unless
 * the watcher is opted in — so a deployment that hasn't set `INFRA_REACHABILITY_WATCH` makes no
 * outbound probes at all. Returns a stop function that clears the timer.
 */
export function startInfraReachabilitySweeper(
  container: ServerContainer,
  clock: Clock,
  log: Logger,
  /** Counts a failed pass under this sweep's name (see {@link startSweeper}). */
  metrics: OperationalMetrics,
): () => void {
  const cfg = container.config.infraReachability
  if (!cfg.enabled) return () => {}
  return startSweeper({
    name: 'infra-reachability',
    intervalMs: cfg.intervalMs,
    log,
    metrics,
    failureMessage: 'infra reachability sweep failed',
    tick: async () => {
      const { raised, cleared } = await sweepInfraReachability(container, log)
      if (raised > 0 || cleared > 0) log.info('infra reachability sweep', { raised, cleared })
    },
  })
}
