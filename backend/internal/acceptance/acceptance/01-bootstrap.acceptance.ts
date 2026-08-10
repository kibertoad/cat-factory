// Spec 01: bootstrap two empty repositories into two board services, wired for k3s.
//
// This is the "start from nothing" half of the suite. Nothing here is faked: the bootstrapper
// agent creates real repositories on the real provider and scaffolds real code into them, and the
// assertions are that the board came out of it in a state work can actually be filed against.
//
// **Why two services rather than one.** The defect spec 03 hunts lives BETWEEN a backend and a
// frontend (see `src/instructions.ts`), so there have to be two repositories for it to live
// between. It also exercises the thing a single-service suite would miss: `resolveRepoTarget`
// walks a task's ancestry to its enclosing service frame and has deliberately NO first-repo
// fallback, so two linked services is the configuration where a mis-linked frame is caught rather
// than silently papered over.
//
// **Why the frames are patched after bootstrap.** A service owns WHERE its manifests live
// (`block.provisioning`) and the workspace owns the ENGINE that applies them (the infra handler).
// Bootstrap produces the repository and the frame; neither half of the provisioning wiring is its
// job, so the suite supplies both here, once, before any run needs them.

import { beforeAll, describe, expect, it } from 'vitest'
import { requireBootstrapped, runBootstrap } from '../src/bootstrap.ts'
import {
  backendBootstrapInstructions,
  backendRepoName,
  frontendBootstrapInstructions,
  frontendRepoName,
} from '../src/instructions.ts'
import { buildK3sConnection, buildK3sSecrets, buildServiceProvisioning } from '../src/k3s.ts'
import { findServiceByTitle } from '../src/publicApi.ts'
import type { ServiceRecord } from '../src/world.ts'
import { assertPrerequisites, harness, serviceTitles } from './fixtures.ts'

// Bootstrapping scaffolds a whole service, its tests, its Dockerfile, its manifests and its CI
// workflow in one container run. 45 minutes is generous on purpose: the budget is here to catch a
// run that has STOPPED, and a slow-but-alive agent failing the suite would be the worse error.
const BOOTSTRAP_BUDGET_MS = 45 * 60 * 1000

describe('bootstrap: two empty repositories become two provisioned board services', () => {
  const { config, client, world, journal } = harness('01-bootstrap')
  const titles = serviceTitles(config.namePrefix)

  // The gate, not a duplicate of spec 00: a pass resumed straight into this file never ran that
  // one, and bootstrapping two repositories against an unwired deployment is the most expensive
  // way there is to discover it.
  beforeAll(assertPrerequisites)

  it('connects the workspace k3s engine for the `kubernetes` provision type', async () => {
    // Idempotent by design: re-registering replaces, so a resumed pass re-asserts the connection
    // rather than needing to know whether a previous one got this far.
    await client.environments.connect({
      connection: buildK3sConnection(config.cluster),
      secrets: buildK3sSecrets(config.cluster),
    })
    journal.say('milestone', `connected ${config.cluster.apiServerUrl} as the 'kubernetes' handler`)
  })

  it('bootstraps the backend service repository', async () => {
    const record = await bootstrapService({
      role: 'backend',
      title: titles.backend,
      repoName: backendRepoName(config.namePrefix, world.value.runId),
      type: 'service',
      instructions: backendBootstrapInstructions(config.cluster.ingressHostTemplate),
    })
    world.patch({ backend: record })
    expect(record.blockId).toBeTruthy()
  })

  it('bootstraps the frontend repository', async () => {
    const backend = world.require('backend')
    const record = await bootstrapService({
      role: 'frontend',
      title: titles.frontend,
      repoName: frontendRepoName(config.namePrefix, world.value.runId),
      type: 'frontend',
      instructions: frontendBootstrapInstructions(
        backend.repoName,
        config.cluster.ingressHostTemplate,
      ),
    })
    world.patch({ frontend: record })
    expect(record.blockId).toBeTruthy()
  })

  it('declares where each service keeps its per-PR manifests', async () => {
    const provisioning = buildServiceProvisioning()
    for (const key of ['backend', 'frontend'] as const) {
      const service = world.require(key)
      const updated = await client.services.update(service.blockId, { provisioning })
      // Read back rather than trusting the 200: the field is a discriminated union whose
      // non-matching branches are ignored, so a wrong-shaped patch can be accepted and stored as
      // something the deployer will later read as "no manifests": an empty environment that
      // looks like a cluster problem.
      expect(updated.provisioning?.type).toBe('kubernetes')
      expect(updated.provisioning?.manifestSource.path).toBe(provisioning.manifestSource.path)
    }
  })

  it('exposes both as services the public API can file work under', async () => {
    const { services } = await client.services.list()
    const found = Object.fromEntries(services.map((service) => [service.serviceId, service]))
    for (const key of ['backend', 'frontend'] as const) {
      const service = world.require(key)
      expect(
        found[service.serviceId],
        `service ${service.serviceId} ('${service.repoName}') is not listed by GET /api/v1/services. ` +
          `A bootstrapped frame becomes a board service only once its repository projection row is ` +
          `linked to it; an unlinked frame holds tasks and can start none of them.`,
      ).toBeDefined()
    }
    journal.finishPhase('both services are on the board and can be filed against')
  })

  /**
   * Bootstrap one service, or pick up whatever a previous pass left of it.
   *
   * Three resume states, because a bootstrap has two moments a pass can die between and they need
   * different actions:
   *
   *   - **A service in the ledger.** Re-checked against the BOARD, not trusted: a ledger entry
   *     whose frame has since been deleted would otherwise carry a resumed pass to a 404 on the
   *     first task filed under it.
   *   - **A job id in the ledger and no service.** The repository exists (the job created it) but
   *     nothing saw the job settle, so re-attach. Starting a second bootstrap here collides with
   *     the name its own predecessor took, and the provider's refusal reads like a stranger's.
   *   - **Neither.** Start one, recording the job id before the first poll.
   */
  async function bootstrapService(options: {
    role: 'backend' | 'frontend'
    title: string
    repoName: string
    type: 'service' | 'frontend'
    instructions: string
  }): Promise<ServiceRecord> {
    const { role, title, repoName, type, instructions } = options
    const existing = world.value[role]
    if (existing) {
      const live = await findServiceByTitle(client, title)
      if (live) {
        journal.say('milestone', `reusing '${repoName}' from a previous pass (${existing.blockId})`)
        return existing
      }
      journal.record(
        'milestone',
        `the ledger names '${repoName}' but the board has no '${title}'; bootstrapping again`,
      )
      console.warn(
        `  ledger names '${repoName}' but the board has no '${title}'; bootstrapping again`,
      )
    }

    const job = await runBootstrap({
      client,
      journal,
      input: { repoName, type, description: title, private: true, instructions },
      budgetMs: BOOTSTRAP_BUDGET_MS,
      existingJobId: world.value.bootstrapJobs[role],
      onStarted: (jobId) =>
        world.patch({ bootstrapJobs: { ...world.value.bootstrapJobs, [role]: jobId } }),
    })
    const { blockId, repoUrl } = requireBootstrapped(job)
    // Cleared only once the job has SETTLED into a frame: while it is null and the service is
    // null, a resume knows there is nothing of this service anywhere.
    world.patch({ bootstrapJobs: { ...world.value.bootstrapJobs, [role]: null } })
    journal.say('milestone', `bootstrapped ${repoUrl ?? repoName} → frame ${blockId}`)
    return { blockId, serviceId: blockId, repoName, repoUrl }
  }
})
