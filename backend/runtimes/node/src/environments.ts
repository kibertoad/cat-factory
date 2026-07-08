import type { Clock } from '@cat-factory/kernel'
import type { Logger, ServerContainer } from '@cat-factory/server'

// Periodic ephemeral-environment TTL teardown for the Node facade — the analogue of
// the Worker's every-2-min cron call to `sweepExpiredEnvironments`. The Node service
// has no cron, so a timer destroys environments whose expiry has elapsed. No-op when
// the environments integration isn't wired (the container has no `environments` module).

/** How often the Node service tears down expired environments. */
const ENVIRONMENT_SWEEP_INTERVAL_MS = 2 * 60 * 1000

/**
 * Start the periodic environment TTL sweep. Runs once immediately then on a timer.
 * Best-effort: a failed sweep is logged and retried next tick, never thrown. Returns a
 * stop function that clears the timer.
 */
export function startEnvironmentSweeper(
  container: ServerContainer,
  clock: Clock,
  log: Logger,
): () => void {
  const environments = container.environments
  if (!environments) return () => {}
  const tick = async () => {
    try {
      const torn = await environments.teardownService.sweepExpired(clock.now())
      if (torn > 0) log.info({ torn }, 'tore down expired environments')
    } catch (error) {
      log.error(
        { err: error instanceof Error ? error.message : String(error) },
        'environment TTL sweep failed',
      )
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), ENVIRONMENT_SWEEP_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
