import type { Clock } from '@cat-factory/kernel'
import type { Env } from '../env'
import { buildContainer } from '../container'

// Cron-driven TTL teardown: destroy environments whose expiry has elapsed. A
// no-op unless the integration is configured (the assembled container then has
// no `environments` module), mirroring `reconcileStaleRepos`. Runs on the
// frequent (2-min) pass so TTLs are honoured promptly.
export async function sweepExpiredEnvironments(env: Env, clock: Clock): Promise<number> {
  const container = buildContainer(env)
  if (!container.environments) return 0
  return container.environments.teardownService.sweepExpired(clock.now())
}
