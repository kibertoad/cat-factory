import {
  type ComposeRuntime,
  composeEnvironmentBackend,
  createBackendRegistries,
} from '@cat-factory/integrations'
import type {
  Block,
  DeployCloneTarget,
  EnvironmentProvider,
  ExecutionInstance,
  Pipeline,
  RepoValidationResult,
  RunRepoContext,
  RunnerJobRef,
  RunnerJobView,
  WorkspaceSnapshot,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

export function defineEnvironmentsConformance(harness: ConformanceHarness): void {
  describe('ephemeral environments', () => {
    it('registers, reads (secret-free), and unregisters an environment provider', async () => {
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const base = `/workspaces/${workspace.id}/environments`

      // The module is wired on every facade (the test env opts in): a fresh
      // workspace has no provider connection — a 200, not the 503 a missing module
      // would return.
      const initial = await call<{ connection: unknown }>('GET', `${base}/connection`)
      expect(initial.status).toBe(200)
      expect(initial.body.connection).toBeNull()

      // Register a provider (a declarative manifest + its secret bundle). register is
      // pure — it validates the manifest (SSRF + secret completeness) and encrypts the
      // bundle at rest; no network. The token is never echoed.
      const manifest = {
        providerId: 'acme-envs',
        label: 'Acme Ephemeral Envs',
        baseUrl: 'https://envs.test/api',
        auth: { type: 'bearer', secretRef: { key: 'API_TOKEN' } },
        provision: {
          method: 'POST',
          pathTemplate: '/environments',
          bodyTemplate: '{"ref":"{{input.blockId}}"}',
        },
        status: { method: 'GET', pathTemplate: '/environments/{{provision.externalId}}' },
        teardown: { method: 'DELETE', pathTemplate: '/environments/{{provision.externalId}}' },
        response: { urlPath: 'url', statusPath: 'state', externalIdPath: 'id' },
      }
      const registered = await call<{ providerId: string; secretKeys: string[] }>(
        'POST',
        `${base}/connection`,
        {
          config: { kind: 'manifest', manifest },
          secrets: { API_TOKEN: 'super-secret-env-token' },
        },
      )
      expect(registered.status).toBe(201)
      expect(registered.body.providerId).toBe('acme-envs')
      expect(registered.body.secretKeys).toEqual(['API_TOKEN'])
      expect(JSON.stringify(registered.body)).not.toContain('super-secret-env-token')

      // It reads back as metadata only — the secret bundle is never on the wire.
      const got = await call<{ connection: { providerId: string; secretKeys: string[] } | null }>(
        'GET',
        `${base}/connection`,
      )
      expect(got.body.connection?.providerId).toBe('acme-envs')
      expect(got.body.connection?.secretKeys).toEqual(['API_TOKEN'])
      expect(JSON.stringify(got.body)).not.toContain('super-secret-env-token')

      // Unregister tombstones it; the connection goes null again.
      const del = await call('DELETE', `${base}/connection`)
      expect(del.status).toBe(204)
      const afterDelete = await call<{ connection: unknown }>('GET', `${base}/connection`)
      expect(afterDelete.body.connection).toBeNull()
    })

    it('round-trips a Kubernetes backend connection (kind + discriminated config)', async () => {
      // The env-backend registry mirrors the runner pool: a `kind` discriminator selects
      // the provider, and the K8s config rides the stored manifest's providerConfig. This
      // must persist + read back identically on D1 and Postgres — a repo that dropped the
      // `kind` column or mangled the config JSON diverges here. No custom CA, so it also
      // passes the Worker's `customTlsSupported: false` guard.
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const base = `/workspaces/${workspace.id}/environments`
      const config = {
        kind: 'kubernetes',
        kubernetes: {
          label: 'k3s',
          apiServerUrl: 'https://cluster.example:6443',
          manifestSource: { type: 'colocated', path: 'k8s' },
          url: { source: 'ingressTemplate', hostTemplate: '{{branch}}.preview.example.com' },
        },
      }
      const registered = await call<{
        kind: string
        providerId: string
        secretKeys: string[]
        config?: { kind: string }
      }>('POST', `${base}/connection`, { config, secrets: { apiToken: 'sa-token' } })
      expect(registered.status).toBe(201)
      expect(registered.body.kind).toBe('kubernetes')
      expect(registered.body.providerId).toBe('kubernetes')
      expect(registered.body.secretKeys).toEqual(['apiToken'])
      expect(registered.body.config?.kind).toBe('kubernetes')
      expect(JSON.stringify(registered.body)).not.toContain('sa-token')

      const got = await call<{
        connection: {
          kind: string
          config?: { kubernetes?: { apiServerUrl: string } }
        } | null
      }>('GET', `${base}/connection`)
      expect(got.body.connection?.kind).toBe('kubernetes')
      expect(got.body.connection?.config?.kubernetes?.apiServerUrl).toBe(
        'https://cluster.example:6443',
      )
    })

    it('round-trips a Docker Compose backend connection on every facade', async () => {
      // The Docker Compose env backend rides the generic manifest member (no typed variant,
      // no migration): its flat config lives in the stored manifest's `providerConfig`. It is
      // a runtime-bound backend (needs a Docker daemon, so only local/Node register it by
      // default), but its CONNECTION persistence is runtime-neutral and must read back
      // identically — a repo that mangled `providerConfig` in the manifest JSON column, or a
      // facade that didn't open its env-connection store to the `compose` kind, diverges here.
      // Registered by reference with a fake runtime (never invoked on the connect/describe
      // paths) so the assertion needs no real daemon.
      // The fake runtime carries the optional build-mode `checkout`/`writeCheckoutFile` seam too
      // (recorded, never invoked on the connect/describe paths asserted here) — it composes the
      // same way the real local runtime does, and the build config below must persist regardless.
      const checkouts: { cloneUrl: string; ref: string }[] = []
      const fakeRuntime: ComposeRuntime = {
        compose: async () => ({ code: 0, stdout: '', stderr: '' }),
        writeProjectFile: async () => '',
        checkout: async (_project, target) => {
          checkouts.push({ cloneUrl: target.cloneUrl, ref: target.ref })
          return { dir: '/tmp/checkout' }
        },
        writeCheckoutFile: async () => '',
      }
      const backendRegistries = createBackendRegistries()
      backendRegistries.environmentBackendRegistry.register(composeEnvironmentBackend(fakeRuntime))

      const { call, createWorkspace } = harness.makeApp(undefined, { backendRegistries })
      const { workspace } = await createWorkspace()
      const base = `/workspaces/${workspace.id}/environments`
      const manifest = {
        providerId: 'compose',
        label: 'Docker Compose',
        baseUrl: 'http://localhost',
        auth: { type: 'none' },
        provision: { method: 'POST', pathTemplate: '' },
        response: {},
        // Build-from-source config: the `build` flag + build timeout must survive the manifest
        // JSON column round-trip identically on both stores (D1 ⇄ Drizzle).
        providerConfig: {
          service: 'web',
          port: '8080',
          composePath: 'docker-compose.yml',
          build: 'true',
          buildTimeoutMinutes: '20',
        },
      }
      const registered = await call<{ kind: string; providerId: string; secretKeys: string[] }>(
        'POST',
        `${base}/connection`,
        { config: { kind: 'compose', manifest }, secrets: {} },
      )
      expect(registered.status).toBe(201)
      expect(registered.body.kind).toBe('compose')
      expect(registered.body.providerId).toBe('compose')
      expect(registered.body.secretKeys).toEqual([])

      const got = await call<{
        connection: {
          kind: string
          config?: { manifest?: { providerConfig?: { service?: string; build?: string } } }
        } | null
      }>('GET', `${base}/connection`)
      expect(got.body.connection?.kind).toBe('compose')
      expect(got.body.connection?.config?.manifest?.providerConfig?.service).toBe('web')
      // The build-mode flag round-trips through the store on every facade.
      expect(got.body.connection?.config?.manifest?.providerConfig?.build).toBe('true')

      // Advertised in the snapshot so the SPA lists it (with its when-to-use guidance).
      const snap = await call<{ environmentBackendKinds?: { kind: string }[] }>(
        'GET',
        `/workspaces/${workspace.id}`,
      )
      expect(snap.body.environmentBackendKinds?.map((k) => k.kind)).toEqual(
        expect.arrayContaining(['compose']),
      )

      // The descriptor-driven connect form exposes the flat fields (service + port required) +
      // the build-from-source selector, so the build toggle ships on every facade's connect UI.
      const descr = await call<{ kind: string; configFields: { key: string }[] }>(
        'GET',
        `${base}/provider?kind=compose`,
      )
      expect(descr.status).toBe(200)
      expect(descr.body.configFields.map((f) => f.key)).toEqual(
        expect.arrayContaining(['service', 'port', 'build']),
      )
      // Registering + describing a build-mode connection must never clone (a clone only happens
      // when a run actually provisions the env).
      expect(checkouts).toHaveLength(0)
    })

    it('surfaces a deployer EnvironmentProvider failure as an `environment` run failure on every facade', async () => {
      // Parity for the deployer spin-up surfacing (PR #446): when a `deployer` step's
      // EnvironmentProvider fails to provision, the engine must record an `environment`
      // run failure carrying the provider's verbatim error AND persist a `failed`
      // EnvironmentRecord that projects back onto the step (`step.environment.lastError`)
      // — not a green step with the error buried in prose. The failed-record round-trip
      // crosses each facade's own registry repo (D1 ⇄ Drizzle), so a runtime that maps
      // the `failed`/`lastError` columns differently — or forgot to wire the failed-record
      // persistence — diverges here instead of shipping silently.
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

      // A registered connection gives `provision` its manifest, so the call reaches the
      // (throwing) provider rather than failing earlier on "no connection".
      const manifest = {
        providerId: 'acme-envs',
        label: 'Acme Ephemeral Envs',
        baseUrl: 'https://envs.test/api',
        auth: { type: 'bearer', secretRef: { key: 'API_TOKEN' } },
        provision: { method: 'POST', pathTemplate: '/environments' },
        response: { urlPath: 'url', statusPath: 'state', externalIdPath: 'id' },
      }
      const registered = await app.call('POST', `/workspaces/${wsId}/environments/connection`, {
        config: { kind: 'manifest', manifest },
        secrets: { API_TOKEN: 'super-secret-env-token' },
      })
      expect(registered.status).toBe(201)

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Deploy only',
        agentKinds: ['deployer'],
      })
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)

      const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      // A real, classified `environment` failure carrying the provider's verbatim error —
      // not a generic run failure, and not a falsely-green step.
      expect(exec.status).toBe('failed')
      expect(exec.failure?.kind).toBe('environment')
      expect(exec.failure?.detail).toContain('ECONNREFUSED')
      const deployStep = exec.steps.find((s) => s.agentKind === 'deployer')!
      expect(deployStep.state).not.toBe('done')
      // The failure is attributed to the in-flight step (the deployer), so the step-detail
      // overlay can filter its per-step execution history — and it round-trips through the facade.
      expect(exec.failure?.stepIndex).toBe(exec.steps.indexOf(deployStep))
      // The failed EnvironmentRecord round-tripped through the facade's registry repo and
      // projects onto the step — the cross-runtime persistence + column-mapping assertion.
      expect(deployStep.environment?.status).toBe('failed')
      expect(deployStep.environment?.lastError).toContain('ECONNREFUSED')
    })

    it('drives the async container-backed deploy lifecycle to an identical environment on every facade', async () => {
      // Per-service provision types (Phase 2, slice 10): a `deployer` step whose provider needs
      // RENDERING (kustomize/helm) stands the env up in a deploy CONTAINER — dispatch a `deploy`
      // job, park, poll, finalize — instead of the synchronous in-Worker REST path.
      //
      // SCOPE: this injects a FAKE `deployJobClient` + `resolveDeployCloneTarget` as core
      // overrides, which each facade harness spreads LAST — so they win over the real wiring
      // (`selectDeployDeps` on the Worker, the pool-backed default on Node, `NativeCliDeployTransport`
      // locally). It therefore does NOT exercise that per-facade transport selection (a
      // wrong-namespace / wrong-image-tag wiring would not be caught here — that is out of this
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
      const manifest = {
        providerId: 'acme-k8s',
        label: 'Acme Kubernetes',
        baseUrl: 'https://k8s.test/api',
        auth: { type: 'bearer', secretRef: { key: 'API_TOKEN' } },
        provision: { method: 'POST', pathTemplate: '/environments' },
        response: { urlPath: 'url', statusPath: 'state', externalIdPath: 'id' },
      }
      const registered = await app.call('POST', `/workspaces/${wsId}/environments/connection`, {
        config: { kind: 'manifest', manifest },
        secrets: { API_TOKEN: 'super-secret-env-token' },
      })
      expect(registered.status).toBe(201)

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Deploy only',
        agentKinds: ['deployer'],
      })
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)

      const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      // The engine dispatched a `deploy`-kind job (carrying the `image: 'deploy'` variant) through
      // the wired client — the slice-10 transport-acceptance assertion.
      expect(dispatched).toHaveLength(1)
      expect(dispatched[0]!.kind).toBe('deploy')
      expect(dispatched[0]!.image).toBe('deploy')
      // The stubbed terminal view finalized into the env record, which round-tripped through the
      // facade's registry repo (D1 ⇄ Drizzle) and projects onto the step — identical on both runtimes.
      const deployStep = exec.steps.find((s) => s.agentKind === 'deployer')!
      expect(deployStep.state).toBe('done')
      expect(deployStep.environment?.status).toBe('ready')
      expect(deployStep.environment?.url).toBe('https://pr-1.preview.test')
    })

    it('registers, lists, rotates, and removes a per-type infra handler on every facade', async () => {
      // Per-service provision types (slice 4): the per-type handler surface (the workspace
      // "how"). A workspace registers one handler per provision type; the batched bundle
      // lists them (sans secret VALUES) alongside the custom-manifest-type catalog. This is
      // the reshaped-connection store read/written through the controller — a repo that
      // mangled the handler row, the engine, or the secret-key projection diverges here.
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const base = `/workspaces/${workspace.id}/environments`

      // A fresh workspace has no handlers and (no registry wired) an empty custom catalog.
      const empty = await call<{ handlers: unknown[]; customTypes: unknown[] }>(
        'GET',
        `${base}/handlers`,
      )
      expect(empty.status).toBe(200)
      expect(empty.body.handlers).toEqual([])
      expect(empty.body.customTypes).toEqual([])

      // Register a kubernetes handler (engine `remote-kubernetes`, backend `kubernetes`).
      // The service-owned manifest source is NOT here — it's merged from the service at
      // provision time — so the handler carries only the apiserver/url engine config.
      const registered = await call<{
        provisionType: string
        engine: string
        providerId: string
        secretKeys: string[]
      }>('POST', `${base}/handlers`, {
        provisionType: 'kubernetes',
        config: {
          engine: 'remote-kubernetes',
          kubernetes: {
            label: 'Prod cluster',
            apiServerUrl: 'https://cluster.example:6443',
            url: { source: 'ingressTemplate', hostTemplate: '{{branch}}.preview.example.com' },
          },
        },
        secrets: { apiToken: 'sa-token-value' },
      })
      expect(registered.status).toBe(201)
      expect(registered.body.provisionType).toBe('kubernetes')
      expect(registered.body.engine).toBe('remote-kubernetes')
      expect(registered.body.secretKeys).toEqual(['apiToken'])
      expect(JSON.stringify(registered.body)).not.toContain('sa-token-value')

      // It lists back as metadata only (no secret values).
      const listed = await call<{
        handlers: { provisionType: string; engine: string }[]
      }>('GET', `${base}/handlers`)
      expect(listed.body.handlers.map((h) => h.provisionType)).toEqual(['kubernetes'])
      expect(listed.body.handlers[0]!.engine).toBe('remote-kubernetes')
      expect(JSON.stringify(listed.body)).not.toContain('sa-token-value')

      // Rotate the secret bundle for the type without re-sending the config.
      const rotated = await call<{ secretKeys: string[] }>(
        'PATCH',
        `${base}/handlers/kubernetes/secrets`,
        { secrets: { apiToken: 'rotated-token' } },
      )
      expect(rotated.status).toBe(200)
      expect(rotated.body.secretKeys).toEqual(['apiToken'])

      // Unregister tombstones it; the bundle goes empty again.
      const del = await call('DELETE', `${base}/handlers/kubernetes`)
      expect(del.status).toBe(204)
      const after = await call<{ handlers: unknown[] }>('GET', `${base}/handlers`)
      expect(after.body.handlers).toEqual([])
    })

    it('CRUDs the workspace custom-manifest-type catalog on every facade', async () => {
      // The UI-editable half of the `custom` provision-type catalog. A workspace defines a
      // manifest type a service can pin (and a `remote-custom` handler can accept); it reads
      // back in the handlers bundle marked `source: 'workspace'`. The custom_manifest_types
      // table round-trips through each facade's store (D1 ⇄ Drizzle).
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const base = `/workspaces/${workspace.id}/environments`

      const created = await call<{ manifestId: string; label: string; source: string }>(
        'PUT',
        `${base}/custom-types/terraform`,
        { label: 'Terraform', description: 'HCL plan + apply' },
      )
      expect(created.status).toBe(200)
      expect(created.body.manifestId).toBe('terraform')
      expect(created.body.source).toBe('workspace')

      const bundle = await call<{ customTypes: { manifestId: string; label: string }[] }>(
        'GET',
        `${base}/handlers`,
      )
      expect(bundle.body.customTypes.map((t) => t.manifestId)).toEqual(['terraform'])
      expect(bundle.body.customTypes[0]!.label).toBe('Terraform')

      const del = await call('DELETE', `${base}/custom-types/terraform`)
      expect(del.status).toBe(204)
      const after = await call<{ customTypes: unknown[] }>('GET', `${base}/handlers`)
      expect(after.body.customTypes).toEqual([])
    })

    it('runs an `infraless` deployer step as a no-op (no environment) on every facade', async () => {
      // Per-service provision types (slice 3): the deployer resolves the SERVICE frame's
      // declared provisioning. A service explicitly declaring `infraless` stands nothing up
      // — the deployer records a no-op step output and the run completes WITHOUT calling the
      // provider or persisting an environment. This is the runtime-neutral engine branch; a
      // facade that wired the deployer differently (or still hit the legacy connection)
      // diverges here. No connection is registered, proving the provider is never reached.
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      // Declare the service frame `infraless` (the run targets a task nested under it).
      await app.call('PATCH', `/workspaces/${wsId}/blocks/blk_auth`, {
        provisioning: { type: 'infraless' },
      })

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Deploy only',
        agentKinds: ['deployer'],
      })
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)

      const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      // The run completed cleanly and the deployer step is done with the no-op output.
      expect(exec.status).toBe('done')
      const deployStep = exec.steps.find((s) => s.agentKind === 'deployer')!
      expect(deployStep.state).toBe('done')
      expect(deployStep.output).toContain('infraless')
      expect(deployStep.environment ?? null).toBeNull()

      // Nothing was provisioned — the registry is empty.
      const envs = await app.call<{ id: string }[]>('GET', `/workspaces/${wsId}/environments`)
      expect(envs.body).toHaveLength(0)
    })

    it('runs a `library` frame`s deploy+test pipeline suite-focused: deployer no-ops, tester runs, no env — even with a compose path declared', async () => {
      // Library-frame support: the frame CAPABILITY PROFILE (`frameProfile`), not the provisioning
      // type, decides behaviour. A `library` frame is never deployed and needs no ephemeral env —
      // its tester runs the suite in-container. So a deploy+test pipeline on a task under a library
      // frame must (a) record the deployer step as a library no-op (never reaching the provider),
      // and (b) run the tester to completion with NO provisioned environment — even when the frame
      // declares a `docker-compose` path (repo-local TEST infra, not a deployable env). A facade
      // that consulted the provision type instead of the frame type would try to deploy here.
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      // A real `library` frame (POST /blocks accepts a block type), with a task nested under it.
      const frame = await app.call<Block>('POST', `/workspaces/${wsId}/blocks`, {
        type: 'library',
        position: { x: 1200, y: 1200 },
      })
      expect(frame.status).toBe(201)
      expect(frame.body.type).toBe('library')
      const libFrameId = frame.body.id

      // Declare a compose path — on a library this is repo-local test infra, NOT an environment.
      // The deployer must STILL skip it (proving profile-over-provisioning).
      await app.call('PATCH', `/workspaces/${wsId}/blocks/${libFrameId}`, {
        provisioning: { type: 'docker-compose', composePath: 'packages/db/docker-compose.yml' },
      })

      const task = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/${libFrameId}/tasks`, {
        title: 'Add a public helper',
        description: 'A new exported utility with tests.',
      })
      expect(task.status).toBe(201)
      const taskId = task.body.id

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Deploy + test',
        agentKinds: ['deployer', 'tester-api'],
      })
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/${taskId}/executions`,
        { pipelineId: pipeline.body.id },
      )
      // The run STARTS (the library short-circuits in the tester-infra / deployer start gates keep
      // a compose-declaring library from being refused for a "missing handler").
      expect(start.status).toBe(201)

      const exec = (await app.drive(wsId)).find((e) => e.blockId === taskId)!
      expect(exec.status).toBe('done')

      // The deployer is a library no-op (records WHY it skipped; provider never reached, no env).
      const deployStep = exec.steps.find((s) => s.agentKind === 'deployer')!
      expect(deployStep.state).toBe('done')
      expect(deployStep.output).toContain('Library frame')
      expect(deployStep.environment ?? null).toBeNull()

      // The tester still ran (suite posture) — a library`s missing env is never a dead-end.
      const testStep = exec.steps.find((s) => s.agentKind === 'tester-api')!
      expect(testStep.state).toBe('done')

      // Nothing was provisioned.
      const envs = await app.call<{ id: string }[]>('GET', `/workspaces/${wsId}/environments`)
      expect(envs.body).toHaveLength(0)
    })

    it('describes the provider config + missingRequired identically on every facade', async () => {
      // `GET /provider` self-describes the connect form (configFields) and reports which
      // required-without-default fields the workspace still owes (`missingRequired`, the
      // unconfigured-provider banner signal). The describe pipeline runs against the real
      // store + cipher — describeConfig over the saved manifest, plus the decrypted secret
      // bundle / manifest providerConfig as the "already supplied" set — so a repo that
      // dropped the manifest or failed to decrypt the bundle would diverge here.
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const base = `/workspaces/${workspace.id}/environments`

      // No connection yet: the generic manifest provider has no manifest to read, so it
      // declares no fields and owes nothing.
      const before = await call<{ missingRequired: string[]; configFields: unknown[] }>(
        'GET',
        `${base}/provider`,
      )
      expect(before.status).toBe(200)
      expect(before.body.missingRequired).toEqual([])

      // After registering a manifest whose bearer auth references API_TOKEN — and
      // supplying it — the field is described AND counts as satisfied, so nothing is
      // missing (the secret bundle round-tripped through the store + cipher).
      const manifest = {
        providerId: 'acme-envs',
        label: 'Acme Ephemeral Envs',
        baseUrl: 'https://envs.test/api',
        auth: { type: 'bearer', secretRef: { key: 'API_TOKEN' } },
        provision: { method: 'POST', pathTemplate: '/environments' },
        response: { urlPath: 'url', statusPath: 'state', externalIdPath: 'id' },
      }
      await call('POST', `${base}/connection`, {
        config: { kind: 'manifest', manifest },
        secrets: { API_TOKEN: 'super-secret-env-token' },
      })

      const after = await call<{
        missingRequired: string[]
        configFields: { key: string }[]
      }>('GET', `${base}/provider`)
      expect(after.body.configFields.map((f) => f.key)).toContain('API_TOKEN')
      expect(after.body.missingRequired).toEqual([])
      expect(JSON.stringify(after.body)).not.toContain('super-secret-env-token')
    })

    it('rejects an internal management-API host under the strict URL policy', async () => {
      // The default (strict) URL/host safety policy forbids private/internal hosts at
      // registration on every runtime — so a trusted-internal deployment (e.g. an
      // in-house adapter on a `.internal` host) MUST opt in via the operator allow-list
      // rather than the host slipping through. The conformance env config sets no
      // allow-list, so the strict default applies identically on D1 and Postgres.
      const { call, createWorkspace } = harness.makeApp()
      const { workspace } = await createWorkspace()
      const manifest = {
        providerId: 'internal-envs',
        label: 'Internal Envs',
        baseUrl: 'https://kargo.internal/api',
        auth: { type: 'bearer', secretRef: { key: 'API_TOKEN' } },
        provision: { method: 'POST', pathTemplate: '/environments' },
        response: { urlPath: 'url', statusPath: 'state', externalIdPath: 'id' },
      }
      const res = await call('POST', `/workspaces/${workspace.id}/environments/connection`, {
        config: { kind: 'manifest', manifest },
        secrets: { API_TOKEN: 't' },
      })
      // A validation failure (the SSRF/internal-host guard), not a 201.
      expect(res.status).toBeGreaterThanOrEqual(400)
    })

    it('runs a native provider repo-config validation through the wired coords resolver', async () => {
      // The repo-config lifecycle (PR #416): a native provider declares repo
      // expectations via `validateRepo`, and the facade wires `resolveRepoFilesForCoords`
      // so the on-demand `POST /connection/validate-repo` route reads the named repo
      // through a checkout-free RepoFiles and returns the provider's verdict. This must
      // behave identically on D1 and Postgres — a facade that forgot to wire the coords
      // resolver (or the controller route) fails here. The provider + resolver are fakes
      // (an in-memory path→content map), so no real GitHub connection is needed; the
      // route degrades to "no VCS connection" when the resolver is absent.
      const seed = (files: Record<string, string>) => {
        const store = new Map(Object.entries(files))
        const repo = {
          getFile: async (path: string) => {
            const content = store.get(path)
            return content != null ? { content, sha: `sha:${path}` } : null
          },
          listDirectory: async () => [],
          headSha: async () => 'base-sha',
          createBranch: async () => {},
          deleteBranch: async () => {},
          commitFiles: async () => ({ sha: 'c' }),
          openPullRequest: async () => ({ number: 1 }) as never,
        }
        return { repo, baseBranch: 'main' }
      }
      // A native provider that requires a `.kargo.yml` carrying a `jobs:` line.
      const provider = {
        provision: async () => ({ externalId: 'e', status: 'ready', url: null }) as never,
        status: async () => ({ externalId: 'e', status: 'ready', url: null }) as never,
        teardown: async () => ({ status: 'torn_down' }) as never,
        validateRepo: async (req: {
          readRepoFile: (p: string) => Promise<{ content: string } | null>
        }) => {
          const file = await req.readRepoFile('.kargo.yml')
          const ok = !!file && file.content.includes('jobs')
          return ok
            ? { ok: true, issues: [] }
            : {
                ok: false,
                issues: [
                  {
                    severity: 'error' as const,
                    message: file ? 'missing jobs' : 'missing .kargo.yml',
                    path: '.kargo.yml',
                  },
                ],
              }
        },
      }

      // A repo WITHOUT a valid config → the route surfaces the provider's error issues.
      const invalid = harness.makeApp(undefined, {
        environmentProvider: provider as unknown as EnvironmentProvider,
        resolveRepoFilesForCoords: async () =>
          seed({ '.kargo.yml': 'name: x\n' }) as unknown as RunRepoContext,
      })
      const wsBad = (await invalid.createWorkspace()).workspace
      // The descriptor advertises the capability identically on every runtime.
      const desc = await invalid.call<{ supportsRepoValidation?: boolean }>(
        'GET',
        `/workspaces/${wsBad.id}/environments/provider`,
      )
      expect(desc.body.supportsRepoValidation).toBe(true)
      const bad = await invalid.call<RepoValidationResult>(
        'POST',
        `/workspaces/${wsBad.id}/environments/connection/validate-repo`,
        { owner: 'acme', repo: 'widgets' },
      )
      expect(bad.status).toBe(200)
      expect(bad.body.ok).toBe(false)
      expect(bad.body.issues[0]?.path).toBe('.kargo.yml')

      // A repo WITH a valid config → ok with no issues (no connection registered first:
      // the route must not 409 when nothing is registered — the on-demand contract).
      const valid = harness.makeApp(undefined, {
        environmentProvider: provider as unknown as EnvironmentProvider,
        resolveRepoFilesForCoords: async () =>
          seed({ '.kargo.yml': 'name: x\njobs: [build]\n' }) as unknown as RunRepoContext,
      })
      const wsGood = (await valid.createWorkspace()).workspace
      const good = await valid.call<RepoValidationResult>(
        'POST',
        `/workspaces/${wsGood.id}/environments/connection/validate-repo`,
        { owner: 'acme', repo: 'widgets' },
      )
      expect(good.status).toBe(200)
      expect(good.body).toEqual({ ok: true, issues: [] })
    })

    it('honours deployment-level detection conventions for service-provisioning detection', async () => {
      // The detection LOGIC is a shared pure function (unit-tested in @cat-factory/integrations);
      // the runtime-specific part is each facade threading `config.environments.detectionConventions`
      // into the core deps. This asserts that wiring on EVERY runtime: a repo whose only compose
      // file uses a NON-canonical name (`stack.yml`) is invisible to a default detector, but is
      // detected once the deployment adds that name via conventions. A facade that forgot the
      // config→deps threading (or wired only one runtime) fails here instead of silently reverting
      // to built-ins. The reader is a fake (an in-memory path→content map) so no GitHub is needed —
      // it flows through the SAME `resolveRepoFilesForCoords` seam the validate-repo route uses.
      const seed = (files: Record<string, string>): RunRepoContext => {
        const paths = Object.keys(files)
        const repo = {
          getFile: async (path: string) =>
            path in files ? { content: files[path]!, sha: `sha:${path}` } : null,
          // A minimal one-level directory listing over the in-memory paths, enough for the
          // compose-file scan (`findCompose` lists the root + common compose dirs).
          listDirectory: async (dir: string) => {
            const prefix = dir ? `${dir}/` : ''
            const seen = new Set<string>()
            const entries: { name: string; type: string; path: string }[] = []
            for (const p of paths) {
              if (prefix && !p.startsWith(prefix)) continue
              const rest = p.slice(prefix.length)
              if (!rest) continue
              const seg = rest.split('/')[0]!
              if (seen.has(seg)) continue
              seen.add(seg)
              entries.push({
                name: seg,
                type: rest.includes('/') ? 'dir' : 'file',
                path: prefix + seg,
              })
            }
            return entries
          },
          headSha: async () => 'base-sha',
          createBranch: async () => {},
          deleteBranch: async () => {},
          commitFiles: async () => ({ sha: 'c' }),
          openPullRequest: async () => ({ number: 1 }) as never,
        }
        return { repo, baseBranch: 'main' } as unknown as RunRepoContext
      }
      const files = { 'stack.yml': 'services:\n  app:\n    image: nginx\n' }
      type DetectResult = { provisioning: { type: string; composePath?: string } }

      // Default (no conventions): the non-canonical name is not a compose file ⇒ nothing detected.
      const plain = harness.makeApp(undefined, {
        resolveRepoFilesForCoords: async () => seed(files),
      })
      const wsPlain = (await plain.createWorkspace()).workspace
      const off = await plain.call<DetectResult>(
        'POST',
        `/workspaces/${wsPlain.id}/environments/detect-provisioning`,
        { owner: 'acme', repo: 'widgets', prefer: 'docker-compose' },
      )
      expect(off.status).toBe(200)
      expect(off.body.provisioning.type).toBe('infraless')

      // With the deployment convention adding `stack.yml`: detected as docker-compose here too.
      const conv = harness.makeApp(undefined, {
        resolveRepoFilesForCoords: async () => seed(files),
        detectionConventions: { composeFiles: ['stack.yml'] },
      })
      const wsConv = (await conv.createWorkspace()).workspace
      const on = await conv.call<DetectResult>(
        'POST',
        `/workspaces/${wsConv.id}/environments/detect-provisioning`,
        { owner: 'acme', repo: 'widgets', prefer: 'docker-compose' },
      )
      expect(on.status).toBe(200)
      expect(on.body.provisioning.type).toBe('docker-compose')
      expect(on.body.provisioning.composePath).toBe('stack.yml')
    })

    it('drives an env-config-repair run to success and records the post-repair validation', async () => {
      // The durable, asynchronous config-repair fallback (PR #424 follow-up): when
      // mechanical bootstrap can't synthesise a valid provider config and the caller opts
      // in, the service dispatches a coding agent as its OWN `env-config-repair` agent_runs
      // run and returns immediately (ok pending) — then re-validates on completion. This
      // must behave identically on D1 and Postgres: a facade that wired the durable repair
      // into only one runtime (or maps the kind-scoped row differently) fails here.
      //
      // A MUTABLE in-memory repo lets us simulate the agent's push: the config file is
      // flipped from invalid to valid between dispatch and drive, so the service's injected
      // re-validation (→ provider.validateRepo) records ok:true. The repairer itself is the
      // deterministic FakeEnvConfigRepairer the harness injects (no GitHub / container).
      const store = new Map<string, string>([['.kargo.yml', 'name: x\n']]) // invalid: no `jobs`
      const repo = {
        getFile: async (path: string) => {
          const content = store.get(path)
          return content != null ? { content, sha: `sha:${path}` } : null
        },
        listDirectory: async () => [],
        headSha: async () => 'base-sha',
        createBranch: async () => {},
        deleteBranch: async () => {},
        commitFiles: async () => ({ sha: 'c' }),
        openPullRequest: async () => ({ number: 1 }) as never,
      }
      const provider = {
        provision: async () => ({ externalId: 'e', status: 'ready', url: null }) as never,
        status: async () => ({ externalId: 'e', status: 'ready', url: null }) as never,
        teardown: async () => ({ status: 'torn_down' }) as never,
        validateRepo: async (req: {
          readRepoFile: (p: string) => Promise<{ content: string } | null>
        }) => {
          const file = await req.readRepoFile('.kargo.yml')
          const ok = !!file && file.content.includes('jobs')
          return ok
            ? { ok: true, issues: [] }
            : {
                ok: false,
                issues: [
                  { severity: 'error' as const, message: 'missing jobs', path: '.kargo.yml' },
                ],
              }
        },
        // Mechanical bootstrap can't synthesise a config → ask for the agent fallback.
        bootstrapProviderConfiguration: async () => ({
          files: [],
          needsAgent: true,
          issues: [{ severity: 'error' as const, message: 'cannot synthesize config' }],
        }),
        // Declares agent-repair support (the fallback's gate; the fake repairer performs it).
        describeRepairAgent: () => ({ prompt: 'Fix .kargo.yml: add a jobs list.' }),
      }

      const app = harness.makeApp(undefined, {
        environmentProvider: provider as unknown as EnvironmentProvider,
        resolveRepoFilesForCoords: async () =>
          ({ repo, baseBranch: 'main' }) as unknown as RunRepoContext,
      })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      // Mechanical bootstrap bails (needsAgent) → the durable repair run is dispatched and
      // the call returns immediately with the run id and ok pending (false).
      const started = await app.call<{ ok: boolean; usedAgent?: boolean; repairJobId?: string }>(
        'POST',
        `/workspaces/${wsId}/environments/connection/bootstrap-repo`,
        { owner: 'acme', repo: 'widgets', inputs: {}, allowAgentFallback: true },
      )
      expect(started.status).toBe(200)
      expect(started.body.usedAgent).toBe(true)
      expect(started.body.ok).toBe(false)
      const jobId = started.body.repairJobId
      expect(jobId).toBeTruthy()

      // Persisted as a running env-config-repair agent_runs row, surfaced on the snapshot
      // (no board block — it's an infra-window run).
      const before = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      const running = before.body.envConfigRepairJobs?.find((j) => j.id === jobId)
      expect(running?.status).toBe('running')

      // Simulate the agent pushing its fix, then drive the durable poll loop (production: a
      // pg-boss queue / an EnvConfigRepairWorkflow). The fake reports `done` on the first
      // poll, which triggers the service's re-validation against the now-valid repo.
      store.set('.kargo.yml', 'name: x\njobs: [build]\n')
      const polls = await app.driveEnvConfigRepair(wsId, jobId!)
      expect(polls).toBeGreaterThanOrEqual(1)

      // Finalised as succeeded with the post-repair validation recorded ok:true — on both
      // D1 and Postgres.
      const after = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      const done = after.body.envConfigRepairJobs?.find((j) => j.id === jobId)
      expect(done?.status).toBe('succeeded')
      expect(done?.ok).toBe(true)
      expect(done?.issues).toEqual([])
    })
  })

  describe('board', () => {
    it('adds a top-level frame', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const res = await app.call<Block>('POST', `/workspaces/${workspace.id}/blocks`, {
        type: 'service',
        position: { x: 10, y: 20 },
      })
      expect(res.status).toBe(201)
      expect(res.body.level).toBe('frame')
    })

    it('deletes a top-level frame and reclaims its backing service in one batched read', async () => {
      // Deleting a top-level frame reclaims the account-owned service it backs — resolved for
      // every doomed frame in ONE batched query (`listByFrameBlocks`), then its row + mounts
      // are deleted. Exercised on every runtime so the batched frame→service lookup can't map
      // differently between stores. GitHub is off in conformance (the only production path that
      // mints a service), so seed a real service linked to the frame directly, then assert the
      // delete actually reclaims it — not just that the block vanished.
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const frame = await app.call<Block>('POST', `/workspaces/${workspace.id}/blocks`, {
        type: 'service',
        position: { x: 0, y: 0 },
      })
      expect(frame.body.level).toBe('frame')
      const serviceId = `svc-${frame.body.id}`
      await app.seedService({
        id: serviceId,
        accountId: null,
        frameBlockId: frame.body.id,
        installationId: null,
        repoGithubId: null,
        createdAt: 1,
      })
      // The service resolves by its frame before deletion.
      expect(await app.getService(serviceId)).not.toBeNull()

      const removed = await app.call(
        'DELETE',
        `/workspaces/${workspace.id}/blocks/${frame.body.id}`,
      )
      expect(removed.status).toBe(204)
      const snap = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${workspace.id}`)
      expect(snap.body.blocks.some((b) => b.id === frame.body.id)).toBe(false)
      // The batched frame→service resolve found the backing service and reclaimed it.
      expect(await app.getService(serviceId)).toBeNull()
    })

    it('adds a user-authored task pinning a pipeline', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const res = await app.call<Block>(
        'POST',
        `/workspaces/${workspace.id}/blocks/blk_auth/tasks`,
        { title: 'Add SSO login', description: 'Support SAML and OIDC.', pipelineId: 'pl_quick' },
      )
      expect(res.status).toBe(201)
      expect(res.body.level).toBe('task')
      expect(res.body.parentId).toBe('blk_auth')
      expect(res.body.title).toBe('Add SSO login')
      expect(res.body.pipelineId).toBe('pl_quick')
    })

    it('rejects a task without a title', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const res = await app.call('POST', `/workspaces/${workspace.id}/blocks/blk_auth/tasks`, {})
      expect(res.status).toBe(400)
    })

    it('adds a module to a service but rejects one on a task', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const ok = await app.call<Block>(
        'POST',
        `/workspaces/${workspace.id}/blocks/blk_auth/modules`,
        { name: 'Tokens' },
      )
      expect(ok.status).toBe(201)
      expect(ok.body.level).toBe('module')

      const bad = await app.call('POST', `/workspaces/${workspace.id}/blocks/task_login/modules`, {
        name: 'Nope',
      })
      expect(bad.status).toBe(422)
    })

    it('updates a block', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const patched = await app.call<Block>(
        'PATCH',
        `/workspaces/${workspace.id}/blocks/blk_auth`,
        { description: 'Updated description' },
      )
      expect(patched.status).toBe(200)
      expect(patched.body.description).toBe('Updated description')
    })

    it('deletes a block idempotently — gone or unknown is a 204, never a 404', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      // A block not existing must never block deletion: a repeated delete, and a delete of an
      // id that never existed, both clean up best-effort and return 204 rather than 404.
      // `blk_frontend` is a childless service (deletable); a service WITH unfinished tasks is
      // archived instead of deleted (asserted separately).
      const first = await app.call('DELETE', `/workspaces/${workspace.id}/blocks/blk_frontend`)
      expect(first.status).toBe(204)
      const again = await app.call('DELETE', `/workspaces/${workspace.id}/blocks/blk_frontend`)
      expect(again.status).toBe(204)
      const unknown = await app.call('DELETE', `/workspaces/${workspace.id}/blocks/blk_nope`)
      expect(unknown.status).toBe(204)
    })

    it('refuses to delete a service with unfinished tasks and archives/restores it', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const ws = workspace.id
      // blk_auth carries planned (unfinished) tasks, so a destructive delete is rejected.
      const del = await app.call('DELETE', `/workspaces/${ws}/blocks/blk_auth`)
      expect(del.status).toBe(422)

      // Archiving hides the service + its whole subtree from the board and surfaces it for restore
      // — the `archived` column must persist + read back identically on every store.
      const archived = await app.call<{ archived?: boolean }>(
        'POST',
        `/workspaces/${ws}/blocks/blk_auth/archive`,
      )
      expect(archived.status).toBe(200)
      expect(archived.body.archived).toBe(true)

      let snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${ws}`)).body
      expect(snap.blocks.find((b) => b.id === 'blk_auth')).toBeUndefined()
      expect(snap.blocks.find((b) => b.id === 'task_login')).toBeUndefined()
      expect(snap.archivedServices?.find((b) => b.id === 'blk_auth')).toBeTruthy()

      const restored = await app.call<{ archived?: boolean }>(
        'POST',
        `/workspaces/${ws}/blocks/blk_auth/restore`,
      )
      expect(restored.status).toBe(200)
      expect(restored.body.archived).toBeFalsy()

      snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${ws}`)).body
      expect(snap.blocks.find((b) => b.id === 'blk_auth')).toBeTruthy()
      expect(snap.blocks.find((b) => b.id === 'task_login')).toBeTruthy()
      expect(snap.archivedServices?.find((b) => b.id === 'blk_auth')).toBeFalsy()
    })
  })
}
