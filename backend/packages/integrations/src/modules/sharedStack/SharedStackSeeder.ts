import {
  type CreateSharedStackInput,
  describeError,
  type Logger,
  type SharedStackSeeder,
} from '@cat-factory/kernel'
import type { SharedStackService } from './SharedStackService.js'

// The generic, deployment-neutral implementation of the kernel {@link SharedStackSeeder} port: a
// fixed list of stack definitions a deployment declared IN CODE, idempotently ensured for a
// workspace. The direct analogue of `createEnvironmentHandlerSeeder` (same shape, same two wiring
// sites, same never-fail-the-caller posture), for the primitive that describes a service's full
// infra dependencies rather than the handler that provisions one.
//
// It carries NO deployment-specific knowledge: a deployment supplies `CreateSharedStackInput`s
// through `startNode`/`startLocal`, whose compose layers may be inline documents, references into
// another repo, or paths in the stack's own clone. See
// docs/initiatives/stack-recipes-and-shared-stacks.md.

/**
 * Build the deployment-neutral {@link SharedStackSeeder}: on `ensureForWorkspace` it lists the
 * workspace's existing stacks ONCE and creates only the seeds whose NAME isn't already present.
 *
 * Identity is the name, not the id: a stack's id is generated per workspace, so nothing a
 * deployment writes down could match one. That makes a re-boot a no-op and a re-created workspace
 * re-seed, and it means an operator who has since EDITED a seeded stack keeps their edit — a seed
 * declares "this workspace should have a stack called X", not "X must look exactly like this".
 *
 * Each creation is wrapped PER SEED so one bad definition (a `path` layer with no clone URL, an
 * unparseable field) is logged and skipped without aborting the others or throwing: the caller is
 * workspace creation or the boot backfill, and neither may fail because of a seed.
 */
export function createSharedStackSeeder(deps: {
  service: Pick<SharedStackService, 'list' | 'create'>
  seeds: CreateSharedStackInput[]
  /** Optional structural logger; a skipped seed surfaces its reason through it. */
  logger?: Logger
}): SharedStackSeeder {
  const { service, seeds, logger } = deps
  return {
    async ensureForWorkspace(workspaceId: string): Promise<void> {
      // Nothing declared ⇒ nothing to do (and no reason to read the stack store at all).
      if (seeds.length === 0) return
      const existing = new Set((await service.list(workspaceId)).map((stack) => stack.name))
      for (const seed of seeds) {
        if (existing.has(seed.name)) continue
        try {
          await service.create(workspaceId, seed)
          logger?.info('seeded shared stack', { workspaceId, name: seed.name })
        } catch (error) {
          // A single malformed seed must not abort the rest or bubble into workspace creation —
          // log it and move on. The next boot's backfill retries it, so a transient failure heals.
          logger?.warn('skipped shared stack seed (creation failed)', {
            workspaceId,
            name: seed.name,
            ...describeError(error),
          })
        }
      }
    },
  }
}
