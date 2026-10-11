import { describeError, type Logger, type RunnerPoolSeeder } from '@cat-factory/kernel'
import type { RunnerBackendConfig } from '@cat-factory/kernel'
import type { RunnerPoolConnectionService } from './RunnerPoolConnectionService.js'

// The generic, deployment-neutral implementation of the kernel {@link RunnerPoolSeeder} port, and
// the runner-pool sibling of `createEnvironmentHandlerSeeder`: same shape, same two wiring sites
// (a boot backfill over every existing workspace, and `WorkspaceService.create`'s on-create hook).
// It carries NO deployment knowledge: a deployment supplies the seed through its composition root.

/**
 * A deployment's pre-declared runner pool: the same `{ config, secrets }` an admin submits through
 * Infrastructure → Runner pool. ONE seed, not a list, because a workspace holds one runner backend.
 */
export interface RunnerPoolSeed {
  config: RunnerBackendConfig
  secrets: Record<string, string>
}

/**
 * Build the deployment-neutral {@link RunnerPoolSeeder}: on `ensureForWorkspace` it registers the
 * seed only when the workspace has no runner pool yet, so a pool an admin registered (or replaced)
 * is never overwritten and a second boot is a no-op. A failed registration (a malformed config, an
 * unregistered backend kind, a missing secret) is logged and swallowed: neither workspace creation
 * nor the boot backfill may fail because of a seed, and the next boot retries it. Without a seed,
 * `ensureForWorkspace` does nothing, not even the presence read.
 */
export function createRunnerPoolSeeder(deps: {
  connectionService: Pick<RunnerPoolConnectionService, 'hasConnection' | 'register'>
  seed: RunnerPoolSeed | undefined
  /** Optional structural logger; a skipped seed surfaces its reason through it. */
  logger?: Logger
}): RunnerPoolSeeder {
  const { connectionService, seed, logger } = deps
  return {
    async ensureForWorkspace(workspaceId: string): Promise<void> {
      if (!seed) return
      if (await connectionService.hasConnection(workspaceId)) return
      try {
        await connectionService.register(workspaceId, seed)
        logger?.info('seeded runner pool', { workspaceId, kind: seed.config.kind })
      } catch (error) {
        logger?.warn('skipped runner pool seed (registration failed)', {
          workspaceId,
          kind: seed.config.kind,
          ...describeError(error),
        })
      }
    },
  }
}
