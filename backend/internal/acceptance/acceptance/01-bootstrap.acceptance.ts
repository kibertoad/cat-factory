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

import { describe, expect, it } from 'vitest'
import { requireBootstrapped, runBootstrap } from '../src/bootstrap.ts'
import {
  backendBootstrapInstructions,
  backendRepoName,
  frontendBootstrapInstructions,
  frontendRepoName,
} from '../src/instructions.ts'
import { buildK3sHandlerConfig, buildK3sSecrets, buildServiceProvisioning } from '../src/k3s.ts'
import { findServiceByTitle } from '../src/publicApi.ts'
import type { ServiceRecord } from '../src/world.ts'
import { harness, serviceTitles } from './fixtures.ts'

// Bootstrapping scaffolds a whole service, its tests, its Dockerfile, its manifests and its CI
// workflow in one container run. 45 minutes is generous on purpose: the budget is here to catch a
// run that has STOPPED, and a slow-but-alive agent failing the suite would be the worse error.
const BOOTSTRAP_BUDGET_MS = 45 * 60 * 1000

describe('bootstrap: two empty repositories become two provisioned board services', () => {
  const { config, client, app, world } = harness()
  const titles = serviceTitles(config.namePrefix)

  it('connects the workspace k3s engine for the `kubernetes` provision type', async () => {
    // Idempotent by design: re-registering replaces, so a resumed pass re-asserts the connection
    // rather than needing to know whether a previous one got this far.
    await app.registerEnvironmentHandler({
      provisionType: 'kubernetes',
      config: buildK3sHandlerConfig(config.cluster),
      secrets: buildK3sSecrets(config.cluster),
    })
    console.log(`  connected ${config.cluster.apiServerUrl} as the 'kubernetes' handler`)
  })

  it('bootstraps the backend service repository', async () => {
    const record = await bootstrapService({
      existing: world.value.backend,
      title: titles.backend,
      repoName: backendRepoName(config.namePrefix, world.value.runId),
      type: 'service',
      instructions: backendBootstrapInstructions(),
    })
    world.patch({ backend: record })
    expect(record.blockId).toBeTruthy()
  })

  it('bootstraps the frontend repository', async () => {
    const backend = world.require('backend')
    const record = await bootstrapService({
      existing: world.value.frontend,
      title: titles.frontend,
      repoName: frontendRepoName(config.namePrefix, world.value.runId),
      type: 'frontend',
      instructions: frontendBootstrapInstructions(backend.repoName),
    })
    world.patch({ frontend: record })
    expect(record.blockId).toBeTruthy()
  })

  it('declares where each service keeps its per-PR manifests', async () => {
    const provisioning = buildServiceProvisioning()
    for (const key of ['backend', 'frontend'] as const) {
      const service = world.require(key)
      const block = await app.setServiceProvisioning(service.blockId, provisioning)
      // Read back rather than trusting the 200: the field is a discriminated union whose
      // non-matching branches are ignored, so a wrong-shaped patch can be accepted and stored as
      // something the deployer will later read as "no manifests": an empty environment that
      // looks like a cluster problem.
      expect(block.provisioning?.type).toBe('kubernetes')
      expect(block.provisioning?.manifestSource?.path).toBe(provisioning.manifestSource?.path)
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
  })

  /**
   * Bootstrap one service, or adopt the one a previous pass already made.
   *
   * The resume path checks the BOARD, not just the ledger: a ledger entry whose frame has since
   * been deleted would otherwise carry a resumed pass all the way to a 404 on the first task.
   */
  async function bootstrapService(options: {
    existing: ServiceRecord | null
    title: string
    repoName: string
    type: 'service' | 'frontend'
    instructions: string
  }): Promise<ServiceRecord> {
    const { existing, title, repoName, type, instructions } = options
    if (existing) {
      const live = await findServiceByTitle(client, title)
      if (live) {
        console.log(`  reusing '${repoName}' from a previous pass (${existing.blockId})`)
        return existing
      }
      console.warn(
        `  ledger names '${repoName}' but the board has no '${title}'; bootstrapping again`,
      )
    }

    const job = await runBootstrap(
      app,
      { repoName, type, description: title, private: true, instructions },
      BOOTSTRAP_BUDGET_MS,
    )
    const { blockId, repoUrl } = requireBootstrapped(job)
    console.log(`  bootstrapped ${repoUrl ?? repoName} → frame ${blockId}`)
    return { blockId, serviceId: blockId, repoName, repoUrl }
  }
})
