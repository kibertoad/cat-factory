import type { Clock } from '@cat-factory/kernel'
import type { CoreDependencies } from '@cat-factory/orchestration'
import type { Env } from '../env'
import { buildContainer } from '../container'

// Cron-driven TTL teardown: destroy environments whose expiry has elapsed. A
// no-op unless the integration is configured (the assembled container then has
// no `environments` module), mirroring `reconcileStaleRepos`. Runs on the
// frequent (2-min) pass so TTLs are honoured promptly.
//
// `overrides` exists only so tests can inject a fake agent executor: building
// the container otherwise trips the sandbox-prerequisite guard (the test bindings
// opt into a sandbox but supply no GitHub App). Production calls this with none.
export async function sweepExpiredEnvironments(
  env: Env,
  clock: Clock,
  overrides: Partial<CoreDependencies> = {},
): Promise<number> {
  const container = buildContainer(env, overrides)
  if (!container.environments) return 0
  return container.environments.teardownService.sweepExpired(clock.now())
}
