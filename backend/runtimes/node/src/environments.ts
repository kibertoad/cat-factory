import type { Clock } from '@cat-factory/kernel'
import type { Logger, ServerContainer } from '@cat-factory/server'
import { startSweeper } from './sweeper.js'

// Periodic ephemeral-environment TTL teardown for the Node facade — the analogue of
// the Worker's every-2-min cron call to `sweepExpiredEnvironments`. The Node service
// has no cron, so a timer destroys environments whose expiry has elapsed. No-op when
// the environments integration isn't wired (the container has no `environments` module).

/** How often the Node service tears down expired environments. */
const ENVIRONMENT_SWEEP_INTERVAL_MS = 2 * 60 * 1000

/**
 * Start the periodic environment TTL sweep. Runs once immediately then on the interval,
 * non-overlapping + best-effort (see {@link startSweeper}). Returns a stop function that
 * clears the timer.
 */
export function startEnvironmentSweeper(
  container: ServerContainer,
  clock: Clock,
  log: Logger,
): () => void {
  const environments = container.environments
  if (!environments) return () => {}
  return startSweeper({
    name: 'environment-ttl',
    intervalMs: ENVIRONMENT_SWEEP_INTERVAL_MS,
    log,
    failureMessage: 'environment TTL sweep failed',
    tick: async () => {
      const torn = await environments.teardownService.sweepExpired(clock.now())
      if (torn > 0) log.info({ torn }, 'tore down expired environments')
    },
  })
}
