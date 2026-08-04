import type { Clock } from '@cat-factory/kernel'
import {
  type Logger,
  type ServerContainer,
  type SweepHealthTracker,
  SPEND_ALERT_INTERVAL_MS,
  sweepSpendAlerts,
} from '@cat-factory/server'
import { startSweeper } from './sweeper.js'

// Periodic spend-ALERT sweep for the Node facade: the analogue of the Worker's cron call to
// `sweepSpendAlerts`, riding the same shared driver and the same shared cadence so the two facades
// warn at the same moment. It forecasts each workspace's (and its account's) metered spend and
// raises a `budget_threshold` card once a threshold is crossed or the projection overruns, which
// is the only warning a team gets before the safeguard starts pausing runs mid-pipeline.
//
// Unlike the platform-health and reachability watchers there is no opt-in flag to check: having
// configured a budget IS the opt-in, and the sweep is a no-op when the notifications module is
// unwired. The Node service has no cron, so a timer drives it.

/**
 * Start the periodic spend-alert sweep. Runs once immediately then on the interval,
 * non-overlapping + best-effort (see {@link startSweeper}). Returns a stop function that clears
 * the timer.
 */
export function startSpendAlertSweeper(
  container: ServerContainer,
  clock: Clock,
  log: Logger,
  /** Records each pass's outcome under this sweep's name (see {@link startSweeper}). */
  health: SweepHealthTracker,
): () => void {
  return startSweeper({
    name: 'spend-alerts',
    intervalMs: SPEND_ALERT_INTERVAL_MS,
    log,
    health,
    failureMessage: 'spend alert sweep failed',
    tick: async () => {
      const { raised } = await sweepSpendAlerts(container, clock.now(), log)
      if (raised > 0) log.info('spend alert sweep', { raised })
    },
  })
}
