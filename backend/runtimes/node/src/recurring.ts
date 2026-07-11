import type { Clock } from '@cat-factory/kernel'
import type { Logger, ServerContainer } from '@cat-factory/server'
import { startSweeper } from './sweeper.js'

// Periodic recurring-pipeline sweep for the Node facade — the analogue of the
// Worker's every-2-min cron call to `runDue`. The Node service has no cron, so a
// timer fires every due schedule (the actual cadence is hours; a frequent tick just
// bounds the latency between "due" and "started"). No-op when the recurring module
// isn't wired.

/** How often the Node service checks for due schedules. */
const SCHEDULE_SWEEP_INTERVAL_MS = 60 * 1000

/**
 * Start the periodic schedule sweep. Runs once immediately then on the interval,
 * non-overlapping + best-effort (see {@link startSweeper}). Returns a stop function that
 * clears the timer.
 */
export function startScheduleSweeper(
  container: ServerContainer,
  clock: Clock,
  log: Logger,
): () => void {
  const recurring = container.recurring
  if (!recurring) return () => {}
  return startSweeper({
    intervalMs: SCHEDULE_SWEEP_INTERVAL_MS,
    log,
    failureMessage: 'recurring-pipeline sweep failed',
    tick: async () => {
      const { fired, skipped } = await recurring.service.runDue(clock.now())
      if (fired > 0 || skipped > 0) {
        log.info({ fired, skipped }, 'fired recurring pipelines')
      }
    },
  })
}
