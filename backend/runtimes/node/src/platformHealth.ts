import type { Clock } from '@cat-factory/kernel'
import { type Logger, type ServerContainer, sweepPlatformHealth } from '@cat-factory/server'
import { startSweeper } from './sweeper.js'

// Periodic platform-health ALERT sweep for the Node facade — the analogue of the Worker's
// every-2-min cron call to `sweepPlatformHealth`. It evaluates each account's aggregate
// run-health projection against the deployment thresholds and raises/clears a `platform_health`
// notification. The Node service has no cron, so a timer drives it (interval from
// `PLATFORM_ALERTS_INTERVAL_MS`, default 5min). No-op unless `PLATFORM_ALERTS` is opted in AND
// the notifications + platform-observability reads are wired (the sweep itself is a further
// no-op when they aren't). Kept symmetric with the Worker via the SAME shared driver.

/**
 * Start the periodic platform-health alert sweep. Runs once immediately then on the interval,
 * non-overlapping + best-effort (see {@link startSweeper}). A NO-OP (returns a no-op stop)
 * unless alerting is opted in — so a deployment that hasn't set `PLATFORM_ALERTS` pays nothing.
 * Returns a stop function that clears the timer.
 */
export function startPlatformHealthSweeper(
  container: ServerContainer,
  clock: Clock,
  log: Logger,
): () => void {
  const cfg = container.config.platformAlerts
  if (!cfg.enabled) return () => {}
  return startSweeper({
    name: 'platform-health',
    intervalMs: cfg.intervalMs,
    log,
    failureMessage: 'platform health sweep failed',
    tick: async () => {
      const { raised, cleared } = await sweepPlatformHealth(container, log)
      if (raised > 0 || cleared > 0) log.info({ raised, cleared }, 'platform health sweep')
    },
  })
}
