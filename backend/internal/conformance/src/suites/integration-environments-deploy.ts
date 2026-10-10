import type {
  DeployCloneTarget,
  EnvironmentProvider,
  ExecutionInstance,
  RunnerJobRef,
  RunnerJobView,
} from '@cat-factory/kernel'
import { expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'
import { seedLegacyPipeline } from '../legacyPipeline.js'

// The deployer's own lifecycle, split out of `integration-environments.ts` when that file reached
// its size budget: a provider failure surfacing as a classified run failure, the note a provider
// leaves on an environment it has not finished standing up, and the async container-backed deploy
// driven end to end. Registered from the environments suite, so it runs on every facade.

/**
 * A minimal registered connection, so a `provision` call reaches the injected provider instead of
 * failing earlier on "no connection". The templates are never interpreted here: every test in this
 * file injects its own provider, and only the registration is real.
 */
const MANIFEST = {
  providerId: 'acme-envs',
  label: 'Acme Ephemeral Envs',
  baseUrl: 'https://envs.test/api',
  auth: { type: 'bearer', secretRef: { key: 'API_TOKEN' } },
  provision: { method: 'POST', pathTemplate: '/environments' },
  response: { urlPath: 'url', statusPath: 'state', externalIdPath: 'id' },
}

/**
 * A deployer EnvironmentProvider failure surfacing as an `environment` run failure, the
 * non-terminal note a provider leaves on an environment still coming up, and the async
 * container-backed deploy lifecycle driven to an identical environment on every facade.
 */
export function registerDeployLifecycleTests(harness: ConformanceHarness): void {
  it("persists a provider's note on an environment that is not ready yet, on every facade", async () => {
    // The channel a `provisioning` provider has and `lastError` is not (issue #2153). `lastError`
    // is written only on `failed` and nulled on every other status, so within a readiness wait the
    // column is structurally always NULL and the deployer's 20-minute ceiling could report nothing
    // but its own duration. `statusNote` is written whatever the status, which is what makes it
    // readable while an environment is still coming up.
    //
    // Cross-runtime because it is a COLUMN: a facade that added the note to one repo's row mapper
    // and not the other, or dropped it from an INSERT's bind list, answers `undefined` here while
    // its sibling answers the note. Asserted through the manual provision route rather than a run,
    // so the assertion lands on a live `provisioning` row instead of on whatever terminal state a
    // driven run leaves behind.
    const provider = {
      provision: async () => ({
        externalId: 'env-1',
        status: 'provisioning',
        url: null,
        expiresAt: null,
        access: null,
        fields: {},
        statusNote: 'the deploy job is queued behind 3 others',
      }),
      status: async () => ({ externalId: 'env-1', status: 'provisioning', url: null }) as never,
      teardown: async () => ({ status: 'torn_down' }) as never,
    }
    const app = harness.makeApp(undefined, {
      environmentProvider: provider as unknown as EnvironmentProvider,
    })
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id
    const registered = await app.call('POST', `/workspaces/${wsId}/environments/connection`, {
      config: { kind: 'manifest', manifest: MANIFEST },
      secrets: { API_TOKEN: 'super-secret-env-token' },
    })
    expect(registered.status).toBe(201)

    const provisioned = await app.call<{ id: string; status: string; statusNote?: string | null }>(
      'POST',
      `/workspaces/${wsId}/environments/provision`,
      { blockId: 'task_login' },
    )
    expect(provisioned.status).toBe(201)
    expect(provisioned.body.status).toBe('provisioning')
    expect(provisioned.body.statusNote).toBe('the deploy job is queued behind 3 others')

    // …and it survives the store, which is the half a facade can get wrong on its own. The read
    // is the persisted row, not the provider: this route does not re-poll.
    const read = await app.call<{
      status: string
      statusNote?: string | null
      lastError?: unknown
    }>('GET', `/workspaces/${wsId}/environments/${provisioned.body.id}`)
    expect(read.body.status).toBe('provisioning')
    expect(read.body.statusNote).toBe('the deploy job is queued behind 3 others')
    // And it is NOT reported as a fault: an environment mid-spin-up has no error, and a note
    // persisted under the error's name would show an operator a failure that never happened.
    expect(read.body.lastError).toBeNull()
  })

  it('surfaces a deployer EnvironmentProvider failure as an `environment` run failure on every facade', async () => {
    // Parity for the deployer spin-up surfacing (PR #446): when a `deployer` step's
    // EnvironmentProvider fails to provision, the engine must record an `environment`
    // run failure carrying the provider's verbatim error AND persist a `failed`
    // EnvironmentRecord that projects back onto the step (`step.environment.lastError`),
    // never a green step with the error buried in prose. The failed-record round-trip
    // crosses each facade's own registry repo (D1 ⇄ Drizzle), so a runtime that maps
    // the `failed`/`lastError` columns differently, or forgot to wire the failed-record
    // persistence, diverges here instead of shipping silently.
    const provider = {
      provision: async () => {
        throw new Error('env API unreachable: ECONNREFUSED')
      },
      status: async () => ({ externalId: 'e', status: 'ready', url: null }) as never,
      teardown: async () => ({ status: 'torn_down' }) as never,
    }
    const app = harness.makeApp(undefined, {
      environmentProvider: provider as unknown as EnvironmentProvider,
    })
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id

    const registered = await app.call('POST', `/workspaces/${wsId}/environments/connection`, {
      config: { kind: 'manifest', manifest: MANIFEST },
      secrets: { API_TOKEN: 'super-secret-env-token' },
    })
    expect(registered.status).toBe(201)

    // Deploy-only: what this asserts on is the deployer step and the environment it did (or did
    // not) leave behind, so there is no disposer. Refused at save, seeded as stored state.
    const pipelineId = await seedLegacyPipeline(app, wsId, {
      id: 'pl_deploy_only',
      name: 'Deploy only',
      purpose: 'build',
      agentKinds: ['deployer'],
    })
    const start = await app.call<ExecutionInstance>(
      'POST',
      `/workspaces/${wsId}/blocks/task_login/executions`,
      { pipelineId },
    )
    expect(start.status).toBe(201)

    const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
    // A real, classified `environment` failure carrying the provider's verbatim error:
    // not a generic run failure, and not a falsely-green step.
    expect(exec.status).toBe('failed')
    expect(exec.failure?.kind).toBe('environment')
    expect(exec.failure?.detail).toContain('ECONNREFUSED')
    const deployStep = exec.steps.find((s) => s.agentKind === 'deployer')!
    expect(deployStep.state).not.toBe('done')
    // The failure is attributed to the in-flight step (the deployer), so the step-detail
    // overlay can filter its per-step execution history, and it round-trips through the facade.
    expect(exec.failure?.stepIndex).toBe(exec.steps.indexOf(deployStep))
    // The failed EnvironmentRecord round-tripped through the facade's registry repo and
    // projects onto the step: the cross-runtime persistence + column-mapping assertion.
    expect(deployStep.environment?.status).toBe('failed')
    expect(deployStep.environment?.lastError).toContain('ECONNREFUSED')
  })

  it('drives the async container-backed deploy lifecycle to an identical environment on every facade', async () => {
    // Per-service provision types (Phase 2, slice 10): a `deployer` step whose provider needs
    // RENDERING (kustomize/helm) stands the env up in a deploy CONTAINER (dispatch a `deploy`
    // job, park, poll, finalize) instead of the synchronous in-Worker REST path.
    //
    // SCOPE: this injects a FAKE `deployJobClient` + `resolveDeployCloneTarget` as core
    // overrides, which each facade harness spreads LAST, so they win over the real wiring
    // (`selectDeployDeps` on the Worker, the pool-backed default on Node, `NativeCliDeployTransport`
    // locally). It therefore does NOT exercise that per-facade transport selection (a
    // wrong-namespace / wrong-image-tag wiring would not be caught here: that is out of this
    // runtime-neutral suite's scope; only local's selection has a dedicated unit test today). What
    // this asserts cross-runtime is two runtime-NEUTRAL things that must hold
    // identically on D1 and Postgres: (1) the engine drives the async lifecycle and forwards the
    // provider's `deploy` kind + `image: 'deploy'` option through whatever client is wired, and
    // (2) the finalized `RunnerJobView` maps into an env record that round-trips through each
    // facade's REAL registry repo (D1 ⇄ Drizzle) to the SAME `ProvisionedEnvironment`. A facade
    // that mapped the finalized record's columns differently diverges here instead of shipping
    // silently.
    const dispatched: { ref: RunnerJobRef; kind: string; image?: string }[] = []
    const doneView: RunnerJobView = {
      state: 'done',
      result: {
        // The harness's structured DeployOutcome on the `custom` channel (namespace/url/status).
        custom: {
          namespace: 'preview-pr-1',
          url: 'https://pr-1.preview.test',
          status: 'ready',
        },
      },
    }
    const deployJobClient = {
      dispatch: async (
        _workspaceId: string | undefined,
        ref: RunnerJobRef,
        _spec: Record<string, unknown>,
        kind: string,
        options?: { image?: string },
      ) => {
        dispatched.push({ ref, kind, ...(options?.image ? { image: options.image } : {}) })
      },
      poll: async () => doneView,
      release: async () => {},
    }
    const resolveDeployCloneTarget = async (): Promise<DeployCloneTarget> => ({
      cloneUrl: 'https://github.com/acme/app.git',
      ref: 'main',
    })
    // A provider that renders asynchronously: `buildProvisionJob` returns a deploy job (so the
    // async path runs), `finalizeProvision` maps the harness DeployOutcome → environment. Its
    // synchronous `provision` must never be reached on this path.
    const provider = {
      provision: async () => {
        throw new Error('the async deploy path must not fall back to synchronous provision')
      },
      status: async () => ({ externalId: 'preview-pr-1', status: 'ready', url: null }) as never,
      teardown: async () => ({ status: 'torn_down' }) as never,
      asyncProvision: {
        buildProvisionJob: (req: { deploy?: { ref: RunnerJobRef } }) => ({
          ref: req.deploy!.ref,
          spec: { jobId: req.deploy!.ref.jobId, renderer: 'kustomize' },
          kind: 'deploy' as const,
          options: { image: 'deploy' as const },
        }),
        finalizeProvision: (view: RunnerJobView) => {
          const outcome = view.result?.custom as {
            namespace: string
            url: string | null
            status: string
          }
          return {
            externalId: outcome.namespace,
            url: outcome.url,
            status: outcome.status as never,
            expiresAt: null,
            access: null,
            fields: {},
          }
        },
      },
    }
    const app = harness.makeApp(undefined, {
      environmentProvider: provider as unknown as EnvironmentProvider,
      deployJobClient: deployJobClient as never,
      resolveDeployCloneTarget,
    })
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id

    // A registered connection gives the provider its manifest (the legacy single-connection
    // path the deployer resolves through when the service declares no per-type provisioning).
    const registered = await app.call('POST', `/workspaces/${wsId}/environments/connection`, {
      config: { kind: 'manifest', manifest: MANIFEST },
      secrets: { API_TOKEN: 'super-secret-env-token' },
    })
    expect(registered.status).toBe(201)

    // Deploy-only: what this asserts on is the deployer step and the environment it did (or did
    // not) leave behind, so there is no disposer. Refused at save, seeded as stored state.
    const pipelineId = await seedLegacyPipeline(app, wsId, {
      id: 'pl_deploy_only',
      name: 'Deploy only',
      purpose: 'build',
      agentKinds: ['deployer'],
    })
    const start = await app.call<ExecutionInstance>(
      'POST',
      `/workspaces/${wsId}/blocks/task_login/executions`,
      { pipelineId },
    )
    expect(start.status).toBe(201)

    const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
    // The engine dispatched a `deploy`-kind job (carrying the `image: 'deploy'` variant) through
    // the wired client: the slice-10 transport-acceptance assertion.
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]!.kind).toBe('deploy')
    expect(dispatched[0]!.image).toBe('deploy')
    // The stubbed terminal view finalized into the env record, which round-tripped through the
    // facade's registry repo (D1 ⇄ Drizzle) and projects onto the step, identical on both runtimes.
    const deployStep = exec.steps.find((s) => s.agentKind === 'deployer')!
    expect(deployStep.state).toBe('done')
    expect(deployStep.environment?.status).toBe('ready')
    expect(deployStep.environment?.url).toBe('https://pr-1.preview.test')
  })
}
