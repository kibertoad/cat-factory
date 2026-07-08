import type { Clock } from '@cat-factory/kernel'
import { escalateStaleNotifications, type Logger, type ServerContainer } from '@cat-factory/server'

// Periodic notification-escalation sweep for the Node facade — the analogue of the
// Worker's every-2-min cron call to `escalateStaleNotifications`. Runs no longer time out
// waiting for a human, so a notification that has waited past its workspace's
// `waitingEscalationMinutes` threshold is flipped yellow → red here. The Node service has
// no cron, so a timer drives it. No-op when the notifications module isn't wired.

/** How often the Node service escalates long-waiting notifications. */
const NOTIFICATION_ESCALATION_INTERVAL_MS = 60 * 1000

/**
 * Start the periodic notification-escalation sweep. Runs once immediately then on a
 * one-minute timer. Best-effort: a failed sweep is logged and retried next tick, never
 * thrown. Returns a stop function that clears the timer.
 */
export function startNotificationEscalationSweeper(
  container: ServerContainer,
  clock: Clock,
  log: Logger,
): () => void {
  if (!container.notifications) return () => {}
  const tick = async () => {
    try {
      const escalated = await escalateStaleNotifications(container, clock.now())
      if (escalated > 0) log.info({ escalated }, 'escalated notifications')
    } catch (error) {
      log.error(
        { err: error instanceof Error ? error.message : String(error) },
        'notification escalation failed',
      )
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), NOTIFICATION_ESCALATION_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
