import type { Clock } from '@cat-factory/kernel'
import type { Logger, ServerContainer } from '@cat-factory/server'

// Periodic recurring-pipeline sweep for the Node facade — the analogue of the
// Worker's every-2-min cron call to `runDue`. The Node service has no cron, so a
// timer fires every due schedule (the actual cadence is hours; a frequent tick just
// bounds the latency between "due" and "started"). No-op when the recurring module
// isn't wired.

/** How often the Node service checks for due schedules. */
export const SCHEDULE_SWEEP_INTERVAL_MS = 60 * 1000

/**
 * Start the periodic schedule sweep. Runs once immediately then on a one-minute
 * timer. Best-effort: a failed sweep is logged and retried next tick, never thrown.
 * Returns a stop function that clears the timer.
 */
export function startScheduleSweeper(
  container: ServerContainer,
  clock: Clock,
  log: Logger,
): () => void {
  const recurring = container.recurring
  if (!recurring) return () => {}
  const tick = async () => {
    try {
      const { fired, skipped } = await recurring.service.runDue(clock.now())
      if (fired > 0 || skipped > 0) {
        log.info({ fired, skipped }, 'fired recurring pipelines')
      }
    } catch (error) {
      log.error(
        { err: error instanceof Error ? error.message : String(error) },
        'recurring-pipeline sweep failed',
      )
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), SCHEDULE_SWEEP_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
