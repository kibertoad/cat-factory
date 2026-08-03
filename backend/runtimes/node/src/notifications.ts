import type { Clock } from '@cat-factory/kernel'
import {
  escalateStaleNotifications,
  type Logger,
  type ServerContainer,
  type SweepHealthTracker,
} from '@cat-factory/server'
import { startSweeper } from './sweeper.js'

// Periodic notification-escalation sweep for the Node facade — the analogue of the
// Worker's every-2-min cron call to `escalateStaleNotifications`. Runs no longer time out
// waiting for a human, so a notification that has waited past its workspace's
// `waitingEscalationMinutes` threshold is flipped yellow → red here. The Node service has
// no cron, so a timer drives it. No-op when the notifications module isn't wired.

/** How often the Node service escalates long-waiting notifications. */
const NOTIFICATION_ESCALATION_INTERVAL_MS = 60 * 1000

/**
 * Start the periodic notification-escalation sweep. Runs once immediately then on the
 * interval, non-overlapping + best-effort (see {@link startSweeper}). Returns a stop
 * function that clears the timer.
 */
export function startNotificationEscalationSweeper(
  container: ServerContainer,
  clock: Clock,
  log: Logger,
  /** Records each pass's outcome under this sweep's name (see {@link startSweeper}). */
  health: SweepHealthTracker,
): () => void {
  if (!container.notifications) return () => {}
  return startSweeper({
    name: 'notification-escalation',
    intervalMs: NOTIFICATION_ESCALATION_INTERVAL_MS,
    log,
    health,
    failureMessage: 'notification escalation failed',
    tick: async () => {
      const escalated = await escalateStaleNotifications(container, clock.now())
      if (escalated > 0) log.info('escalated notifications', { escalated })
    },
  })
}
