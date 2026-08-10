// Spec 01: adopt two operator-created repositories, then scaffold both through `pl_build`.
//
// This is the "start from nothing" half of the suite, and nothing here is faked: real container
// agents write real code into real repositories and merge real pull requests.
//
// **Why the operator creates the repositories.** This spec used to bootstrap them, and on the
// deployment shape the suite's own README offers first it could not: `VcsPatConnectionService`
// reports `canCreateRepos: false` for every PAT connection, and the App path creates only under
// `/orgs/{org}/repos`, so a personal account was never a supported target either. Creating them by
// hand and adopting them needs no platform change at all (`POST /api/v1/services` already backs a
// service by `repoId`), and it drops the one prerequisite no configuration could satisfy. The
// bootstrapper agent is therefore no longer this spec's subject; `pl_build` is, from the same
// briefs. Decision record: `docs/initiatives/acceptance-suite-operator-setup.md`.
//
// **Why two services rather than one.** The defect spec 03 hunts lives BETWEEN a backend and a
// frontend (see `src/instructions.ts`), so there have to be two repositories for it to live
// between. It also exercises the thing a single-service suite would miss: `resolveRepoTarget`
// walks a task's ancestry to its enclosing service frame and has deliberately NO first-repo
// fallback, so two linked services is the configuration where a mis-linked frame is caught rather
// than silently papered over.
//
// **Why provisioning is declared BEFORE the scaffold runs.** A service owns WHERE its manifests
// live (`block.provisioning`) and the workspace owns the ENGINE that applies them (the infra
// handler). `pl_build` contains a `deployer` step, so a scaffold run started against a frame with
// no manifest source would reach that step and report an empty source, which reads like a broken
// cluster. Both halves of the wiring are supplied here, once, before any run needs them.

import { beforeAll, describe, expect, it } from 'vitest'
import { adoptRepoAsService, type ServiceType } from '../src/adopt.ts'
import { backendScaffoldBrief, frontendScaffoldBrief } from '../src/instructions.ts'
import { buildK3sConnection, buildK3sSecrets, buildServiceProvisioning } from '../src/k3s.ts'
import { filePinnedTask } from '../src/publicApi.ts'
import { fileAndDrive } from '../src/resume.ts'
import { requireRunDone } from '../src/runDriver.ts'
import type { RunRecord, ServiceRecord } from '../src/world.ts'
import { assertPrerequisites, harness, serviceTitles } from './fixtures.ts'

/** What each half of the pair is, as `POST /api/v1/services` names it. */
const SERVICE_TYPES: Record<'backend' | 'frontend', ServiceType> = {
  backend: 'service',
  frontend: 'frontend',
}

// The scaffold brief is the whole specification. Same steer as spec 02's, and for the same reason:
// the run must implement what it was told, including the offset convention that is one half of the
// planted mismatch, rather than improving on it.
const STEER =
  'Implement exactly what the task description specifies, including its stated conventions and ' +
  'worked examples. Do not broaden the scope.'

describe('setup: two empty repositories become two scaffolded board services', () => {
  const { config, client, world, journal } = harness('01-adopt-and-scaffold')
  const titles = serviceTitles(config.namePrefix)

  // The gate, not a duplicate of spec 00: a pass resumed straight into this file never ran that
  // one, and scaffolding two services against an unwired deployment is the most expensive way
  // there is to discover it.
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

  it('backs a board service with each operator-created repository', async () => {
    for (const role of ['backend', 'frontend'] as const) {
      const record = await adopt(role)
      world.set(role, record)
      expect(record.serviceId).toBeTruthy()
    }
  })

  it('declares where each service keeps its per-PR manifests', async () => {
    const provisioning = buildServiceProvisioning()
    for (const role of ['backend', 'frontend'] as const) {
      const service = world.require(role)
      const updated = await client.services.update(service.blockId, { provisioning })
      // Read back rather than trusting the 200: the field is a discriminated union whose
      // non-matching branches are ignored, so a wrong-shaped patch can be accepted and stored as
      // something the deployer will later read as "no manifests": an empty environment that
      // looks like a cluster problem.
      expect(updated.provisioning?.type).toBe('kubernetes')
      expect(updated.provisioning?.manifestSource.path).toBe(provisioning.manifestSource.path)
    }
  })

  it('scaffolds the backend service through pl_build', async () => {
    const record = await scaffold({
      role: 'backend',
      ledgerKey: 'scaffoldBackend',
      title: 'Stand up the catalog API service',
      brief: backendScaffoldBrief(config.cluster.ingressHostTemplate),
    })
    expect(record.pullRequestUrl).toBeTruthy()
  })

  it('scaffolds the frontend through pl_build', async () => {
    // Sequential, and only after the backend has MERGED: the frontend brief names the backend
    // repository as the service it renders, so an agent reading it while that repository is still
    // empty has nothing to read.
    const backend = world.require('backend')
    const record = await scaffold({
      role: 'frontend',
      ledgerKey: 'scaffoldFrontend',
      title: 'Stand up the catalog web frontend',
      brief: frontendScaffoldBrief(backend.repoName, config.cluster.ingressHostTemplate),
    })
    expect(record.pullRequestUrl).toBeTruthy()
  })

  it('exposes both as services the public API can file work under', async () => {
    const { services } = await client.services.list()
    const found = Object.fromEntries(services.map((service) => [service.serviceId, service]))
    for (const role of ['backend', 'frontend'] as const) {
      const service = world.require(role)
      expect(
        found[service.serviceId],
        `service ${service.serviceId} ('${service.repoName}') is not listed by GET /api/v1/services. ` +
          `A frame becomes a board service only once its repository projection row is linked to it; ` +
          `an unlinked frame holds tasks and can start none of them.`,
      ).toBeDefined()
    }
    journal.finishPhase('both services are scaffolded and can be filed against')
  })

  /**
   * Adopt one repository, or re-read whatever a previous pass adopted.
   *
   * The ledger is consulted first but never trusted: an entry whose frame has since been deleted
   * would otherwise carry a resumed pass to a 404 on the first task filed under it. When it is
   * gone, `adoptRepoAsService` re-reads the repository projection, which is what knows whether a
   * service already backs it.
   */
  async function adopt(role: 'backend' | 'frontend'): Promise<ServiceRecord> {
    const existing = world.value[role]
    if (existing) {
      const { services } = await client.services.list()
      if (services.some((service) => service.serviceId === existing.serviceId)) {
        journal.say('milestone', `reusing service ${existing.serviceId} from a previous pass`)
        return existing
      }
      journal.record(
        'milestone',
        `the ledger names service ${existing.serviceId} but the board no longer lists it; ` +
          `adopting '${config.repos[role]}' again`,
      )
    }
    return adoptRepoAsService({
      client,
      journal,
      repoName: config.repos[role],
      repoOwner: config.repoOwner,
      title: titles[role],
      type: SERVICE_TYPES[role],
      description: `Acceptance pass ${world.value.runId}`,
    })
  }

  /**
   * File the scaffold task (or pick up the one a previous pass filed) and drive it to `done`.
   *
   * The same `fileAndDrive` spec 02 and 03 use, which is the point of scaffolding through a
   * pipeline rather than through a bootstrap job: a pass killed mid-scaffold re-attaches to the
   * live run instead of re-filing an afternoon of work.
   */
  async function scaffold(options: {
    role: 'backend' | 'frontend'
    ledgerKey: 'scaffoldBackend' | 'scaffoldFrontend'
    title: string
    brief: string
  }): Promise<RunRecord> {
    const service = world.require(options.role)
    const { run, record } = await fileAndDrive({
      client,
      journal,
      existing: world.value[options.ledgerKey],
      label: options.title,
      createTask: () =>
        filePinnedTask(client, config, service.serviceId, {
          title: options.title,
          taskType: 'feature',
          description: options.brief,
        }),
      onRecord: (next) => world.set(options.ledgerKey, next),
      pipelineId: 'pl_build',
      steer: STEER,
      budgetMs: config.runBudgetMs,
    })
    requireRunDone(run, `scaffolding '${options.title}'`)
    journal.say(
      'milestone',
      `'${options.title}' merged as ${run.pullRequest?.url ?? '(no PR recorded)'} into ` +
        `${service.repoName}`,
    )
    return record
  }
})
