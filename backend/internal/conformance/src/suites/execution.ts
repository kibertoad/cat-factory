import {
  type Block,
  type EnvironmentProvider,
  type ExecutionInstance,
  type ForkDecisionStepState,
  InitiativePresetRegistry,
  type Pipeline,
  type RequirementReview,
  type RiskPolicy,
  type WorkspaceSnapshot,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { FakeTesterQualityReviewer } from '../FakeTesterQualityReviewer.js'
import type { ConformanceHarness } from '../harness.js'
import { STORAGE_OFF, STORAGE_ON, spawnedInitiative } from './shared.js'

export function defineExecutionConformance(harness: ConformanceHarness): void {
  describe(`[${harness.name}] conformance`, () => {
    describe('execution engine', () => {
      it('runs a task pipeline to auto-merge and materialises its module', async () => {
        const app = harness.makeApp({ confidence: 1 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: 'pl_quick' },
        )
        expect(start.status).toBe(201)
        expect(start.body.status).toBe('running')

        const ticked = await app.drive(wsId)
        const exec = ticked.find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        expect(exec.steps.every((s) => s.state === 'done')).toBe(true)
        expect(exec.steps[0]!.output).toContain('[coder]')
        expect(exec.steps[0]!.model).toBe('fake')
        for (const s of exec.steps) {
          expect(typeof s.startedAt).toBe('number')
          expect(typeof s.finishedAt).toBe('number')
          expect(s.finishedAt!).toBeGreaterThanOrEqual(s.startedAt!)
        }

        // The model is surfaced up front, while the (inline) step is still querying:
        // there is an emit where the first step is `working` with its model already
        // set — not only the final `done` snapshot. Guards the early model preview so
        // it can't regress to "model appears only once the result lands".
        const querying = app
          .executionEmits('task_login')
          .find((e) => e.steps[0]?.state === 'working' && e.steps[0]?.model === 'fake')
        expect(
          querying,
          'expected an emit with the first step querying and its model set',
        ).toBeTruthy()

        const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
        const task = snap.blocks.find((b) => b.id === 'task_login')!
        expect(task.status).toBe('done')
        expect(task.confidence).toBe(1)
        // task_login is assigned to the existing "Sessions" module → moved inside it.
        expect(task.parentId).toBe('mod_sessions')
      })

      it('persists task agent-config and surfaces the contribution catalog', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        // The catalog is derived from the seeded pipelines' agent kinds — which include
        // `playwright`, so its `playwright.e2eTarget` descriptor must be present on BOTH stores.
        const snap0 = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
        expect(snap0.agentConfigCatalog?.some((d) => d.id === 'playwright.e2eTarget')).toBe(true)

        // A task created with an explicit agent-config value round-trips through the store.
        const created = await app.call<Block>(
          'POST',
          `/workspaces/${wsId}/blocks/mod_sessions/tasks`,
          { title: 'Configured task', agentConfig: { 'playwright.e2eTarget': 'ephemeral' } },
        )
        expect(created.status).toBe(201)
        expect(created.body.agentConfig).toEqual({ 'playwright.e2eTarget': 'ephemeral' })

        const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
        const task = snap.blocks.find((b) => b.id === created.body.id)!
        expect(task.agentConfig).toEqual({ 'playwright.e2eTarget': 'ephemeral' })
      })

      it('starts a Tester pipeline for an `infraless` (or undeclared) service', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Code + test',
          agentKinds: ['coder', 'tester-api'],
        })

        // No provisioning declared → the Tester runs with no infra (the gate passes through).
        const undeclared = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(undeclared.status).toBe(201)

        // Explicitly `infraless` on the service frame also starts. `task_login` sits
        // directly under its service frame (no intervening module), so its parent IS the
        // service frame the engine resolves config from.
        const blocks = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body.blocks
        const serviceFrameId = blocks.find((b) => b.id === 'task_login')!.parentId!
        await app.call('PATCH', `/workspaces/${wsId}/blocks/${serviceFrameId}`, {
          provisioning: { type: 'infraless' },
        })
        const ok = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(ok.status).toBe(201)
      })

      it('loops the fixer until the tester greenlights, then completes', async () => {
        // Drive the Tester→Fixer loop on BOTH runtimes: the first report withholds its
        // greenlight (the engine dispatches the fixer and re-tests), the second greenlights.
        // `pooledContainer` models a container-reusing runner whose harness JobRegistry
        // survives between rounds: the re-test MUST get a fresh per-round dispatch epoch, or
        // it re-attaches to the first round's stale "found a bug" report and never re-runs
        // (the bug where the Tester appeared to pass regardless). With the epoch it runs anew
        // and reads the SECOND report, so the run only converges when the loop truly re-tests.
        const notGreen = {
          greenlight: false,
          summary: 'found a bug',
          tested: ['login'],
          outcomes: [{ name: 'login', status: 'failed' as const, detail: 'returns 500' }],
          concerns: [{ title: 'Login 500', detail: 'unhandled error', severity: 'high' as const }],
        }
        const green = {
          greenlight: true,
          summary: 'all good',
          tested: ['login'],
          outcomes: [{ name: 'login', status: 'passed' as const }],
          concerns: [],
        }
        const app = harness.makeApp({
          asyncKinds: ['coder', 'tester-api', 'fixer'],
          asyncPolls: 1,
          pooledContainer: true,
          testReports: [notGreen, green],
          pullRequest: { url: 'https://gh/pr/1', number: 1, branch: 'cat-factory/task_login' },
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Code + test loop',
          agentKinds: ['coder', 'tester-api'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)

        const ticked = await app.drive(wsId)
        const exec = ticked.find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        const testerStep = exec.steps.find((s) => s.agentKind === 'tester-api')!
        expect(testerStep.state).toBe('done')
        // One fixer attempt was dispatched, and the final report greenlit.
        expect(testerStep.test?.attempts).toBe(1)
        expect(testerStep.test?.lastReport?.greenlight).toBe(true)
      })

      it('loops the Tester via the quality-control companion until coverage is adequate, then completes', async () => {
        // Both reports greenlight with no concerns, so the FIXER never runs — but the QC reviewer
        // judges the first report's coverage inadequate (it claims three areas but records one
        // outcome), so the engine loops the Tester for a focused additional pass on its OWN budget,
        // then the second report's coverage is adequate and the run advances. Drives the full QC
        // loop — inject a deterministic reviewer, audit → re-run → audit → conclude — on EVERY
        // runtime, asserting the verdicts + counters persist identically through the step JSON.
        const shallow = {
          greenlight: true,
          summary: 'happy path only',
          tested: ['login', 'logout', 'session refresh'],
          outcomes: [{ name: 'login', status: 'passed' as const }],
          concerns: [],
        }
        const thorough = {
          greenlight: true,
          summary: 'covered every area',
          tested: ['login', 'logout', 'session refresh'],
          outcomes: [
            { name: 'login', status: 'passed' as const },
            { name: 'logout', status: 'passed' as const },
            { name: 'session refresh', status: 'passed' as const },
          ],
          concerns: [],
        }
        const reviewer = new FakeTesterQualityReviewer([
          {
            adequate: false,
            gaps: ['logout not exercised', 'session refresh not exercised'],
            feedback:
              'Only the happy path was checked; two claimed areas have no recorded outcome.',
          },
          { adequate: true, gaps: [], feedback: 'Every listed area now has a recorded outcome.' },
        ])
        const app = harness.makeApp(
          {
            asyncKinds: ['coder', 'tester-api'],
            asyncPolls: 1,
            testReports: [shallow, thorough],
            pullRequest: { url: 'https://gh/pr/2', number: 2, branch: 'cat-factory/task_login' },
          },
          { testerQualityReviewer: reviewer },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Code + test + QC',
          agentKinds: ['coder', 'tester-api'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)

        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')

        const testerStep = exec.steps.find((s) => s.agentKind === 'tester-api')!
        expect(testerStep.state).toBe('done')
        // The QC companion looped the Tester exactly once, on its OWN budget — the fixer never ran.
        expect(testerStep.testerQuality?.attempts).toBe(1)
        expect(testerStep.test?.attempts).toBe(0)
        // Two QC verdicts recorded (inadequate → adequate); the round-trip through the step JSON
        // is identical on D1 and Drizzle.
        expect(testerStep.testerQuality?.verdicts.map((v) => v.adequate)).toEqual([false, true])
        expect(testerStep.testerQuality?.verdicts[0]?.gaps.length).toBeGreaterThan(0)
        expect(testerStep.testerQuality?.exceeded).toBeFalsy()
        // The final, adequate report is the one that concluded the step.
        expect(testerStep.test?.lastReport?.summary).toBe('covered every area')
        // The reviewer audited exactly two reports (the shallow one, then the thorough re-run).
        expect(reviewer.calls).toHaveLength(2)
        expect(reviewer.calls.map((c) => c.adequate)).toEqual([false, true])
      })

      it('persists the tester docker-compose stand-up record on both stores', async () => {
        // The in-container compose stand-up (local-infra tester) is captured by the harness and
        // surfaced on the Tester step so the test window can show WHY local infra failed to come
        // up. Assert it round-trips through persist → reload onto `step.test.infraSetup`
        // identically on both runtimes — a FAILED stand-up with captured logs is the high-signal
        // case the whole feature exists for. (Like `lastReport`, it lives in the step JSON blob,
        // so this also pins the D1 ⇄ Drizzle mapper parity for the new field.)
        const green = {
          greenlight: true,
          summary: 'covered the unit-level paths',
          tested: ['login'],
          outcomes: [{ name: 'login', status: 'passed' as const }],
          concerns: [],
        }
        const infraSetup = {
          started: false,
          composePath: 'docker-compose.yml',
          at: 1_700_000_000_000,
          durationMs: 4200,
          error: 'service db exited (1)',
          logs: 'db-1  | FATAL: database "app" does not exist\ndb-1 exited with code 1',
        }
        const app = harness.makeApp({
          asyncKinds: ['coder', 'tester-api'],
          asyncPolls: 1,
          testReports: [green],
          testerInfraSetup: infraSetup,
          pullRequest: { url: 'https://gh/pr/9', number: 9, branch: 'cat-factory/task_login' },
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Code + test',
          agentKinds: ['coder', 'tester-api'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)

        const ticked = await app.drive(wsId)
        const exec = ticked.find((e) => e.blockId === 'task_login')!
        const testerStep = exec.steps.find((s) => s.agentKind === 'tester-api')!
        expect(testerStep.test?.infraSetup).toEqual(infraSetup)
      })

      it('refuses a frontend UI-tester with no live service under test, reading frontend_config on both stores', async () => {
        // Slice 3 (frontend-preview-ui-testing): a `tester-ui` on a task under a `type: 'frontend'`
        // frame is gated on the frame's `frontendConfig` — it needs at least one bound service with
        // a LIVE ephemeral env (the "service under test"). With the env integration ON (this suite's
        // default) but nothing provisioned, every binding resolves to a mock, so the start is refused
        // with `frontend-no-live-service`. This pins the D1 ⇄ Drizzle parity of reading the
        // `frontend_config` JSON column DURING A RUN: a facade that dropped/mismapped the column
        // would resolve to "no frontend config", fall through to the (empty) backend-service branch,
        // and let the run START (201) instead of refusing it (409). The pure binding→URL resolution
        // (the live service-under-test URL) is covered by the `resolveFrontendBindings` unit tests.
        // Binary storage is wired so this refusal is the FRONTEND gate, not the storage gate.
        const app = harness.makeApp(undefined, { resolveBinaryArtifactStore: STORAGE_ON })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        // Configure the SEEDED `blk_frontend` frame (a `type: 'frontend'` frame in the board seed)
        // rather than creating one via `POST /blocks`: addFrame registers an account-owned service
        // (serviceRepository.insert), which the mothership harness's read-scoped remote proxy can't
        // write — so a fresh frame would 500 there. The seeded frame exists on every harness, so
        // this exercises the frontend gate uniformly. PATCH its config: one `service` binding with
        // no live env, plus a mock binding.
        const frameId = 'blk_frontend'
        const patched = await app.call<Block>('PATCH', `/workspaces/${wsId}/blocks/${frameId}`, {
          frontendConfig: {
            packageManager: 'pnpm',
            buildScript: 'build',
            backendBindings: [
              { envVar: 'PUB_API_URL', source: { kind: 'service', serviceBlockId: 'blk_auth' } },
              { envVar: 'PUB_OTHER_URL', source: { kind: 'mock' } },
            ],
          },
        })
        expect(patched.status).toBe(200)

        // A task inside the frontend frame, and a UI-tester pipeline run against it.
        const task = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/${frameId}/tasks`, {
          title: 'Exercise the dashboard',
        })
        expect(task.status).toBe(201)
        const taskId = task.body.id!
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + UI test',
          agentKinds: ['coder', 'tester-ui'],
        })
        const blocked = await app.call<{
          error: { code: string; details?: { reason?: string; infraReason?: string } }
        }>('POST', `/workspaces/${wsId}/blocks/${taskId}/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(blocked.status).toBe(409)
        expect(blocked.body.error.code).toBe('conflict')
        expect(blocked.body.error.details?.reason).toBe('tester_infra_unsupported')
        expect(blocked.body.error.details?.infraReason).toBe('frontend-no-live-service')
      })

      it('gates a visual pipeline to a frame with a UI (refuse on a bare service, allow once a frontend links it)', async () => {
        // Slice 4c (frontend-preview-ui-testing): a pipeline with a VISUAL step (`tester-ui` /
        // `visual-confirmation`) may run only where there is a UI to exercise — a `frontend` frame,
        // or a frame a `frontend` frame links to. `task_login` lives under the `blk_auth` SERVICE
        // frame, which has no frontend linked in the seed, so a visual pipeline is refused up-front
        // with `visual_pipeline_no_frontend`. Once the seeded frontend frame BINDS `blk_auth`
        // (a frontend→service link), the same run is allowed and starts. This pins the D1 ⇄ Drizzle
        // parity of reading `frontend_config` to discover the link during a run-start gate: a facade
        // that dropped/mismapped the column would find no link and refuse the allowed case too.
        // Binary storage is wired so the allowed run isn't refused by the storage gate instead.
        const app = harness.makeApp(undefined, { resolveBinaryArtifactStore: STORAGE_ON })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Visual build',
          agentKinds: ['coder', 'tester-ui', 'visual-confirmation'],
        })

        // No frontend links `blk_auth` yet ⇒ the visual pipeline is refused on `task_login`.
        const refused = await app.call<{
          error: { code: string; details?: { reason?: string; frameType?: string | null } }
        }>('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(refused.status).toBe(409)
        expect(refused.body.error.code).toBe('conflict')
        expect(refused.body.error.details?.reason).toBe('visual_pipeline_no_frontend')
        expect(refused.body.error.details?.frameType).toBe('service')

        // Link the seeded frontend frame to `blk_auth`: now the service HAS a frontend, so the same
        // visual pipeline is allowed to start on its task.
        await app.call('PATCH', `/workspaces/${wsId}/blocks/blk_frontend`, {
          frontendConfig: {
            backendBindings: [
              { envVar: 'PUB_API_URL', source: { kind: 'service', serviceBlockId: 'blk_auth' } },
            ],
          },
        })
        const started = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(started.status).toBe(201)
      })

      // Skipped on the mothership harness: this test runs a real `deployer` (registering an
      // environment connection + provisioning through it), which drives the env connect/provision
      // write surface. That surface is deliberately NOT exposed over the mothership RPC boundary
      // yet (see `packages/server/src/persistence/rpc.ts`: `environmentRegistryRepository` is
      // read-only there and `environmentConnectionRepository` is unproxied — "the connect/provision
      // surface ... is a later slice"), so it 500s on that node. The sibling refusal test above
      // stays mothership-safe because it only reads/PATCHes seeded blocks. Every OTHER harness
      // (node/local/worker, real persistence) exercises the full provision path here.
      it.skipIf(harness.name === 'mothership')(
        'resolves a frontend `service` binding to a live env keyed by the service FRAME id',
        async () => {
          // Slice 4b (frontend-preview-ui-testing): a `deployer` keys its ephemeral env under the
          // task `block_id` it ran on, but a `frontend` frame's `service` binding names a service
          // FRAME id. So the env now also records the resolved service `frame_id`, and
          // `resolveFrontendConfig` matches handles on THAT. This asserts both cross-runtime facts:
          //   (1) the `frame_id` column round-trips through each facade's registry repo (D1 ⇄
          //       Drizzle) — a facade that dropped/mismapped it would key the env under `null`, and
          //   (2) with the bound service's env live under its frame, the frontend infra gate is
          //       SATISFIED and the UI-tester run STARTS (201) — the mirror of the sibling refusal
          //       test, where the same binding had no live env and was refused (409).
          // The deployer runs on `task_login` (a task under the seeded `blk_auth` service frame), so
          // the env keys under `blk_auth`; the frontend binds `blk_auth` and resolves to its URL.
          const provider = {
            provision: async () => ({
              externalId: 'auth-env-1',
              status: 'ready',
              url: 'https://auth-live.example',
              expiresAt: null,
              access: null,
              fields: {},
            }),
            status: async () =>
              ({
                externalId: 'auth-env-1',
                status: 'ready',
                url: 'https://auth-live.example',
              }) as never,
            teardown: async () => ({ status: 'torn_down' }) as never,
          }
          const app = harness.makeApp(undefined, {
            environmentProvider: provider as unknown as EnvironmentProvider,
            resolveBinaryArtifactStore: STORAGE_ON,
          })
          const { workspace } = await app.createWorkspace()
          const wsId = workspace.id

          // A registered connection gives `provision` its manifest (the legacy single-connection
          // path), so the deployer reaches the injected provider rather than failing on "no connection".
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

          // Provision the auth service's live env by running a `deployer` on a task inside its frame.
          const deployPipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
            name: 'Deploy auth',
            agentKinds: ['deployer'],
          })
          const startDeploy = await app.call(
            'POST',
            `/workspaces/${wsId}/blocks/task_login/executions`,
            {
              pipelineId: deployPipeline.body.id,
            },
          )
          expect(startDeploy.status).toBe(201)
          await app.drive(wsId)

          // The env is keyed by the service FRAME (`blk_auth`) AND the task the deployer ran on —
          // the `frame_id` column round-trip across each facade's registry repo.
          const envs = await app.call<
            {
              blockId: string | null
              frameId?: string | null
              status: string
              url: string | null
            }[]
          >('GET', `/workspaces/${wsId}/environments`)
          expect(envs.body).toHaveLength(1)
          expect(envs.body[0]!.blockId).toBe('task_login')
          expect(envs.body[0]!.frameId).toBe('blk_auth')
          expect(envs.body[0]!.status).toBe('ready')

          // Bind the frontend frame to that service FRAME (plus a mock upstream).
          const patched = await app.call<Block>(
            'PATCH',
            `/workspaces/${wsId}/blocks/blk_frontend`,
            {
              frontendConfig: {
                packageManager: 'pnpm',
                buildScript: 'build',
                backendBindings: [
                  {
                    envVar: 'PUB_API_URL',
                    source: { kind: 'service', serviceBlockId: 'blk_auth' },
                  },
                  { envVar: 'PUB_OTHER_URL', source: { kind: 'mock' } },
                ],
              },
            },
          )
          expect(patched.status).toBe(200)

          // A UI-tester run against the frontend now STARTS: the live service-under-test resolved via
          // `frame_id`, so the frontend infra gate is satisfied instead of refusing the run.
          const task = await app.call<Block>(
            'POST',
            `/workspaces/${wsId}/blocks/blk_frontend/tasks`,
            {
              title: 'Exercise the dashboard',
            },
          )
          const uiPipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
            name: 'Build + UI test',
            agentKinds: ['coder', 'tester-ui'],
          })
          const started = await app.call(
            'POST',
            `/workspaces/${wsId}/blocks/${task.body.id}/executions`,
            {
              pipelineId: uiPipeline.body.id,
            },
          )
          expect(started.status).toBe(201)
        },
      )

      it.skipIf(harness.name === 'mothership')(
        'fans a deployer out over the task own + involved-service frames, keying each env by frame',
        async () => {
          // Service-connections Phase 2 (multi-env provisioning): a task that names an involved
          // connected service provisions an ephemeral env for BOTH its own service frame AND the
          // involved one, all under the task `block_id` but keyed by distinct `frame_id`. This
          // asserts the cross-runtime facts a facade could diverge on:
          //   (1) TWO env records are persisted for one task, keyed by their service FRAME — the
          //       per-`(block_id, frame_id)` supersede that stops the fan-out clobbering itself
          //       (a facade keying by block alone would end with ONE), and
          //   (2) both round-trip the `frame_id` column through each store's registry repo
          //       (D1 ⇄ Drizzle), so a downstream tester's peer-env resolution (which indexes live
          //       handles by frame id) can reach each.
          let provisioned = 0
          const provider = {
            provision: async () => {
              provisioned += 1
              return {
                externalId: `env-${provisioned}`,
                status: 'ready',
                url: `https://env-${provisioned}.example`,
                expiresAt: null,
                access: null,
                fields: {},
              }
            },
            status: async () => ({ status: 'ready' }) as never,
            teardown: async () => ({ status: 'torn_down' }) as never,
          }
          const app = harness.makeApp(undefined, {
            environmentProvider: provider as unknown as EnvironmentProvider,
          })
          const { workspace } = await app.createWorkspace()
          const wsId = workspace.id

          // One workspace-wide connection gives the legacy single-connection provision path its
          // manifest, so every frame's deployer reaches the injected provider.
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

          // A second service frame (the involved peer), connected to the seeded `blk_auth`.
          const peer = await app.call<Block>('POST', `/workspaces/${wsId}/blocks`, {
            type: 'service',
            position: { x: 900, y: 900 },
          })
          const peerId = peer.body.id
          const connected = await app.call('PATCH', `/workspaces/${wsId}/blocks/blk_auth`, {
            serviceConnections: [{ serviceBlockId: peerId, description: 'sends its mail via it' }],
          })
          expect(connected.status).toBe(200)
          // The task under `blk_auth` marks the peer as directly involved.
          const involved = await app.call<Block>('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
            involvedServiceIds: [peerId],
          })
          expect(involved.body.involvedServiceIds).toEqual([peerId])

          const deployPipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
            name: 'Deploy',
            agentKinds: ['deployer'],
          })
          const started = await app.call(
            'POST',
            `/workspaces/${wsId}/blocks/task_login/executions`,
            { pipelineId: deployPipeline.body.id },
          )
          expect(started.status).toBe(201)
          const runs = await app.drive(wsId)
          const run = runs.find((r) => r.blockId === 'task_login')!
          expect(run.status).toBe('done')

          // BOTH frames were provisioned, keyed by distinct frame ids under the one task block.
          const envs = await app.call<
            {
              blockId: string | null
              frameId?: string | null
              status: string
              url: string | null
            }[]
          >('GET', `/workspaces/${wsId}/environments`)
          expect(envs.body).toHaveLength(2)
          const byFrame = new Map(envs.body.map((e) => [e.frameId, e]))
          expect(new Set(byFrame.keys())).toEqual(new Set(['blk_auth', peerId]))
          for (const env of envs.body) {
            expect(env.blockId).toBe('task_login')
            expect(env.status).toBe('ready')
            expect(env.url).toMatch(/^https:\/\/env-\d\.example$/)
          }
          // The two envs carry DISTINCT urls (each frame got its own provision), so a peer-env
          // resolution keyed by frame id resolves the right one.
          expect(byFrame.get('blk_auth')!.url).not.toBe(byFrame.get(peerId)!.url)
        },
      )

      it.skipIf(harness.name === 'mothership')(
        'injects the derived frontend origins into the deployer provision and stamps run-start notes',
        async () => {
          // Slice 6b (frontend-preview-ui-testing): the REVERSE of a frontend's backend bindings —
          // the browser origins a bound service's ephemeral env must accept (CORS) — is derived by
          // reading the frontend frame's `frontend_config` and passed to the deployer as
          // `inputs.frontendOrigins` (which an operator's manifest folds in via
          // `{{input.frontendOrigins}}`; the render itself is unit-tested in 6a). This pins the
          // cross-runtime half: a facade that dropped/mismapped `frontend_config` would derive NO
          // origins. It ALSO asserts the run-start `notes` (the resolved-binding advisories) round-
          // trip through each store's `agent_runs.detail` JSON (D1 ⇄ Drizzle).
          let capturedFrontendOrigins: string | undefined
          const provider = {
            provision: async (req: { inputs: Record<string, string> }) => {
              capturedFrontendOrigins = req.inputs.frontendOrigins
              return {
                externalId: 'auth-env-1',
                status: 'ready',
                url: 'https://auth-live.example',
                expiresAt: null,
                access: null,
                fields: {},
              }
            },
            status: async () =>
              ({
                externalId: 'auth-env-1',
                status: 'ready',
                url: 'https://auth-live.example',
              }) as never,
            teardown: async () => ({ status: 'torn_down' }) as never,
          }
          const app = harness.makeApp(undefined, {
            environmentProvider: provider as unknown as EnvironmentProvider,
            resolveBinaryArtifactStore: STORAGE_ON,
          })
          const { workspace } = await app.createWorkspace()
          const wsId = workspace.id

          // A manifest connection gives the deployer a provider to reach; its `bodyTemplate` is
          // where the operator folds the derived origins into the backend's CORS allow-list.
          const manifest = {
            providerId: 'acme-envs',
            label: 'Acme Ephemeral Envs',
            baseUrl: 'https://envs.test/api',
            auth: { type: 'bearer', secretRef: { key: 'API_TOKEN' } },
            provision: {
              method: 'POST',
              pathTemplate: '/environments',
              bodyTemplate: '{"cors":"{{input.frontendOrigins}}"}',
            },
            response: { urlPath: 'url', statusPath: 'state', externalIdPath: 'id' },
          }
          const registered = await app.call('POST', `/workspaces/${wsId}/environments/connection`, {
            config: { kind: 'manifest', manifest },
            secrets: { API_TOKEN: 'super-secret-env-token' },
          })
          expect(registered.status).toBe(201)

          // Bind the frontend frame to the auth service BEFORE provisioning, so the deployer
          // derives the frontend's origin. A duplicate env var (mock, then `service` LAST so the
          // live binding wins the resolution) makes the run-start note deterministic.
          const patched = await app.call('PATCH', `/workspaces/${wsId}/blocks/blk_frontend`, {
            frontendConfig: {
              backendBindings: [
                { envVar: 'PUB_API_URL', source: { kind: 'mock' } },
                { envVar: 'PUB_API_URL', source: { kind: 'service', serviceBlockId: 'blk_auth' } },
              ],
            },
          })
          expect(patched.status).toBe(200)

          // Provision the auth service's live env via a deployer on a task inside its frame.
          const deployPipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
            name: 'Deploy auth',
            agentKinds: ['deployer'],
          })
          const startDeploy = await app.call(
            'POST',
            `/workspaces/${wsId}/blocks/task_login/executions`,
            { pipelineId: deployPipeline.body.id },
          )
          expect(startDeploy.status).toBe(201)
          await app.drive(wsId)

          // The derived origin (the frontend's default serve port) reached the provider — proving
          // each store read `frontend_config` to compute `frontendOriginsForService`.
          expect(capturedFrontendOrigins).toBe('http://localhost:4173')

          // A UI-tester run against the frontend now starts (blk_auth is live) and carries the
          // duplicate-env-var run-start note.
          const task = await app.call<Block>(
            'POST',
            `/workspaces/${wsId}/blocks/blk_frontend/tasks`,
            { title: 'Exercise the dashboard' },
          )
          const uiPipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
            name: 'Build + UI test',
            agentKinds: ['coder', 'tester-ui'],
          })
          const started = await app.call<{
            id: string
            notes?: string[]
            frontendBindings?: { envVar: string; serviceUrl?: string }[]
          }>('POST', `/workspaces/${wsId}/blocks/${task.body.id}/executions`, {
            pipelineId: uiPipeline.body.id,
          })
          expect(started.status).toBe(201)
          expect(started.body.notes?.some((n) => n.includes('PUB_API_URL'))).toBe(true)
          // The bindings resolved once at start are stamped on the run as a frozen snapshot: the
          // (last-wins) `service` binding resolved to blk_auth's live env URL.
          expect(started.body.frontendBindings).toContainEqual({
            envVar: 'PUB_API_URL',
            serviceUrl: 'https://auth-live.example',
          })

          // Re-read from the store (fresh snapshot): the note AND the frozen bindings persisted in
          // `agent_runs.detail` identically on D1 and Postgres.
          const snapshot = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
          const persisted = snapshot.body.executions.find((e) => e.id === started.body.id)
          expect(persisted?.notes?.some((n) => n.includes('only the last binding'))).toBe(true)
          expect(persisted?.frontendBindings).toContainEqual({
            envVar: 'PUB_API_URL',
            serviceUrl: 'https://auth-live.example',
          })
        },
      )

      // Slice 5c (frontend-preview-ui-testing): the browsable-preview lifecycle + its ephemeral
      // `environments`-row persistence, driven through a FAKE preview transport (the real one is a
      // per-runtime differentiator, wired only in local). Skipped on Cloudflare (the Worker reports
      // `frontendPreview.supported: false` and wires no transport → the controller 503s) and on
      // mothership (its harness wires no preview fake). Asserts the runtime-neutral half: start
      // persists a `preview`-typed env row keyed by the FRAME, get drives it to `ready` with the
      // served URL, and stop soft-deletes it — the D1 ⇄ Drizzle env-row parity for a preview.
      it.skipIf(harness.name === 'cloudflare' || harness.name === 'mothership')(
        'starts, serves and stops a browsable frontend preview keyed by the frame',
        async () => {
          const app = harness.makeApp()
          const { workspace } = await app.createWorkspace()
          const wsId = workspace.id

          // Nothing running yet.
          const before = await app.call<{ status: string }>(
            'GET',
            `/workspaces/${wsId}/frames/blk_frontend/preview`,
          )
          expect(before.status).toBe(200)
          expect(before.body.status).toBe('stopped')

          // Start → 201, provisioning; a `preview`-typed env row is persisted keyed by the FRAME.
          const started = await app.call<{ status: string; frameId: string }>(
            'POST',
            `/workspaces/${wsId}/frames/blk_frontend/preview`,
          )
          expect(started.status).toBe(201)
          expect(started.body.status).toBe('starting')
          expect(started.body.frameId).toBe('blk_frontend')

          // The preview row shares the `environments` table but is NOT a provisioned environment,
          // so it must be ISOLATED from the deployer-env listing the SPA renders (the persistence
          // itself is proven by the preview endpoints below, which read it back on both runtimes).
          const envs = await app.call<unknown[]>('GET', `/workspaces/${wsId}/environments`)
          expect(envs.body).toHaveLength(0)

          // Get → the fake transport reports it serving, so it flips to `ready` with the URL.
          const ready = await app.call<{ status: string; url?: string }>(
            'GET',
            `/workspaces/${wsId}/frames/blk_frontend/preview`,
          )
          expect(ready.status).toBe(200)
          expect(ready.body.status).toBe('ready')
          expect(ready.body.url).toBe('http://preview.test:4173')

          // Stop → soft-deletes the row; a subsequent get reports `stopped` again.
          const stopped = await app.call<{ status: string }>(
            'DELETE',
            `/workspaces/${wsId}/frames/blk_frontend/preview`,
          )
          expect(stopped.status).toBe(200)
          expect(stopped.body.status).toBe('stopped')

          const after = await app.call<{ status: string }>(
            'GET',
            `/workspaces/${wsId}/frames/blk_frontend/preview`,
          )
          expect(after.body.status).toBe('stopped')
          const envsAfter = await app.call<unknown[]>('GET', `/workspaces/${wsId}/environments`)
          expect(envsAfter.body).toHaveLength(0)
        },
      )

      it('refuses to start a UI-tester pipeline when the account has no binary storage', async () => {
        // The `tester-ui` step uploads its screenshots to the binary-artifact store, so the
        // engine refuses to START the pipeline when the account has none configured — a clear
        // `binary_storage_unconfigured` conflict the SPA turns into a "configure storage" prompt.
        // Driven with a null-returning store resolver so the refusal is asserted on every runtime
        // (the Worker binds R2 by default, so this is the only way to reach the off path there).
        // No agent behaviour is configured: the run is refused at start, so nothing ever dispatches.
        const { call, createWorkspace } = harness.makeApp(undefined, {
          resolveBinaryArtifactStore: STORAGE_OFF,
        })
        const { workspace } = await createWorkspace()
        const wsId = workspace.id
        // Slice 4c: a visual pipeline (`tester-ui` / `visual-confirmation`) is gated to a frame
        // with a UI. This run targets `task_login` under the `blk_auth` SERVICE frame, so first
        // link the seeded frontend frame to `blk_auth` (making it "a service with a frontend
        // linked to it") — otherwise the run is refused by the frame-type gate BEFORE it can reach
        // the binary-storage gate this test asserts.
        await call('PATCH', `/workspaces/${wsId}/blocks/blk_frontend`, {
          frontendConfig: {
            backendBindings: [
              { envVar: 'PUB_API_URL', source: { kind: 'service', serviceBlockId: 'blk_auth' } },
            ],
          },
        })
        const pipeline = await call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'UI test (no storage)',
          agentKinds: ['coder', 'tester-ui', 'visual-confirmation'],
        })
        const blocked = await call<{
          error: { code: string; details?: { reason?: string } }
        }>('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(blocked.status).toBe(409)
        expect(blocked.body.error.code).toBe('conflict')
        expect(blocked.body.error.details?.reason).toBe('binary_storage_unconfigured')
      })

      it('drives the visual-confirmation gate to completion (pass-through or park → approve)', async () => {
        // A `tester-ui` → `visual-confirmation` tail: the UI tester greenlights, then the gate
        // is reached. A `tester-ui` pipeline now needs binary storage configured to START at all
        // (the start gate), so we inject a non-null store resolver here. With a store wired the
        // visual-confirmation gate parks awaiting the human; approving advances it. Either way the
        // gate kind is engine-delegated and the run finishes — this pins both the delegation and
        // the approve path across runtimes.
        const green = {
          greenlight: true,
          summary: 'ui looks good',
          tested: ['dashboard'],
          outcomes: [{ name: 'dashboard', status: 'passed' as const }],
          concerns: [],
        }
        const app = harness.makeApp(
          {
            asyncKinds: ['coder', 'tester-ui'],
            asyncPolls: 1,
            testReports: [green],
            pullRequest: { url: 'https://gh/pr/2', number: 2, branch: 'cat-factory/task_login' },
          },
          { resolveBinaryArtifactStore: STORAGE_ON },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        // Slice 4c: link the seeded frontend frame to `blk_auth` so the visual pipeline is allowed
        // to run on `task_login` (under that service frame) — see the binary-storage test above.
        await app.call('PATCH', `/workspaces/${wsId}/blocks/blk_frontend`, {
          frontendConfig: {
            backendBindings: [
              { envVar: 'PUB_API_URL', source: { kind: 'service', serviceBlockId: 'blk_auth' } },
            ],
          },
        })

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'UI test + visual confirmation',
          agentKinds: ['coder', 'tester-ui', 'visual-confirmation'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)

        let exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        // Store wired ⇒ the gate parks awaiting the human; approve it, then drive to completion.
        if (exec.status !== 'done') {
          const gate = exec.steps.find((s) => s.agentKind === 'visual-confirmation')
          expect(gate?.state).toBe('waiting_decision')
          await app.call(
            'POST',
            `/workspaces/${wsId}/blocks/task_login/visual-confirmation/approve`,
            {},
          )
          exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        }
        expect(exec.status).toBe('done')
        const gateStep = exec.steps.find((s) => s.agentKind === 'visual-confirmation')!
        expect(gateStep.state).toBe('done')
      })

      it('visual-confirmation request-fix dispatches the fixer, re-parks, then approves', async () => {
        // Exercises the gate's fix loop (only reachable when a binary-artifact store is wired, so
        // the gate parks rather than passing through): a parked gate + a human "request a fix"
        // dispatches the Tester's `fixer`, and when that job settles the gate re-parks (recording
        // the round + bumping attempts) so the human can approve. A `tester-ui` pipeline now needs
        // storage to START, so we inject a non-null store resolver — which also makes the gate park
        // (rather than pass through), so the fix loop is reachable on every runtime. We still assert
        // completion either way, and the fix-loop assertions only when the gate actually parked.
        const green = {
          greenlight: true,
          summary: 'ui looks good',
          tested: ['dashboard'],
          outcomes: [{ name: 'dashboard', status: 'passed' as const }],
          concerns: [],
        }
        const app = harness.makeApp(
          {
            asyncKinds: ['coder', 'tester-ui', 'fixer'],
            asyncPolls: 1,
            testReports: [green],
            pullRequest: { url: 'https://gh/pr/3', number: 3, branch: 'cat-factory/task_login' },
          },
          { resolveBinaryArtifactStore: STORAGE_ON },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        // Slice 4c: link the seeded frontend frame to `blk_auth` so the visual pipeline is allowed
        // to run on `task_login` (under that service frame) — see the binary-storage test above.
        await app.call('PATCH', `/workspaces/${wsId}/blocks/blk_frontend`, {
          frontendConfig: {
            backendBindings: [
              { envVar: 'PUB_API_URL', source: { kind: 'service', serviceBlockId: 'blk_auth' } },
            ],
          },
        })

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'UI test + visual confirmation (fix)',
          agentKinds: ['coder', 'tester-ui', 'visual-confirmation'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)

        let exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        if (exec.status !== 'done') {
          // Store wired ⇒ parked. Request a fix from findings: the fixer dispatches.
          let gate = exec.steps.find((s) => s.agentKind === 'visual-confirmation')!
          expect(gate.state).toBe('waiting_decision')
          await app.call(
            'POST',
            `/workspaces/${wsId}/blocks/task_login/visual-confirmation/request-fix`,
            { findings: 'The header is misaligned on the dashboard view.' },
          )
          // Drive the fixer job to completion; the gate re-parks awaiting the human.
          exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
          gate = exec.steps.find((s) => s.agentKind === 'visual-confirmation')!
          expect(gate.state).toBe('waiting_decision')
          expect(gate.visualConfirm?.attempts).toBe(1)
          expect(gate.visualConfirm?.rounds?.length).toBe(1)
          expect(gate.visualConfirm?.rounds?.[0]?.outcome).toBe('completed')
          // Now approve and drive to completion.
          await app.call(
            'POST',
            `/workspaces/${wsId}/blocks/task_login/visual-confirmation/approve`,
            {},
          )
          exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        }
        expect(exec.status).toBe('done')
      })

      it('always loops the fixer on the FIRST round, then treats low/medium concerns as advisory', async () => {
        // The FIRST testing round hands ANY finding back to the fixer — even a single
        // low-severity nit — so the first batch of issues is always addressed. From the
        // SECOND round onward low/medium concerns are advisory: only a high/critical
        // blocker withholds the greenlight, so the run isn't stuck re-fixing a nit forever.
        const greenWithNit = {
          greenlight: true,
          summary: 'all good, one minor nit',
          tested: ['login'],
          outcomes: [{ name: 'login', status: 'passed' as const }],
          concerns: [{ title: 'naming', detail: 'rename a var', severity: 'low' as const }],
        }
        const app = harness.makeApp({
          asyncKinds: ['coder', 'tester-api', 'fixer'],
          asyncPolls: 1,
          // The SAME nit on both rounds: round 1 loops the fixer (first batch always
          // does); round 2 greenlights it (now advisory).
          testReports: [greenWithNit, greenWithNit],
          pullRequest: { url: 'https://gh/pr/1', number: 1, branch: 'cat-factory/task_login' },
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Code + test nit',
          agentKinds: ['coder', 'tester-api'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        const testerStep = exec.steps.find((s) => s.agentKind === 'tester-api')!
        expect(testerStep.state).toBe('done')
        // The first-round nit looped the fixer exactly once; the second-round nit was advisory.
        expect(testerStep.test?.attempts).toBe(1)
        expect(testerStep.test?.lastReport?.greenlight).toBe(true)
        // The fixer round was recorded as an inspectable attempt (so the test window can
        // surface what each otherwise-opaque fixer sub-job did), with the concerns it was handed.
        expect(testerStep.test?.attemptLog).toHaveLength(1)
        expect(testerStep.test?.attemptLog?.[0]?.outcome).toBe('completed')
        // The fixer was handed the first round's report — the same nit (`naming`).
        expect(testerStep.test?.attemptLog?.[0]?.concerns?.[0]?.title).toBe('naming')
      })

      it('aborts the run (no fixer) when the tester reports it cannot test', async () => {
        // The Tester reports `abort` (its ephemeral environment never came up, say): the engine
        // must STOP the run for a human — fail it, leave the step un-`done` — and NOT loop the
        // fixer (which can't provision infrastructure). No fixer ⇒ attempts stays 0.
        const aborted = {
          greenlight: false,
          summary: 'could not stand up the environment',
          tested: [],
          outcomes: [],
          concerns: [],
          abort: { reason: 'the ephemeral environment failed to provision' },
        }
        const app = harness.makeApp({
          asyncKinds: ['coder', 'tester-api', 'fixer'],
          asyncPolls: 1,
          testReports: [aborted],
          pullRequest: { url: 'https://gh/pr/9', number: 9, branch: 'cat-factory/task_login' },
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Code + test abort',
          agentKinds: ['coder', 'tester-api'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('failed')
        const testerStep = exec.steps.find((s) => s.agentKind === 'tester-api')!
        expect(testerStep.state).not.toBe('done')
        // The fixer was NOT dispatched — an abort is handed straight to a human.
        expect(testerStep.test?.attempts ?? 0).toBe(0)
        expect(testerStep.test?.attemptLog ?? []).toHaveLength(0)
      })

      it('loops the fixer when a report greenlights but a check FAILED (a failed outcome is a blocker)', async () => {
        // Defensive verdict: a `failed` outcome is itself a blocker, so the engine must NOT
        // accept a report that greenlights with a red check — it loops the fixer regardless of
        // the greenlight flag. The first report greenlights yet has a failed outcome (so it must
        // be rejected and dispatch the fixer); the second is cleanly green (so the run converges).
        // Without the failed-outcome guard the first report is accepted at attempts=0 and the run
        // completes without ever fixing the red check.
        const greenButFailed = {
          greenlight: true,
          summary: 'shipping it',
          tested: ['login'],
          outcomes: [{ name: 'login', status: 'failed' as const, detail: 'returns 500' }],
          concerns: [],
        }
        const green = {
          greenlight: true,
          summary: 'all good',
          tested: ['login'],
          outcomes: [{ name: 'login', status: 'passed' as const }],
          concerns: [],
        }
        const app = harness.makeApp({
          asyncKinds: ['coder', 'tester-api', 'fixer'],
          asyncPolls: 1,
          testReports: [greenButFailed, green],
          pullRequest: { url: 'https://gh/pr/7', number: 7, branch: 'cat-factory/task_login' },
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Code + test failed-outcome',
          agentKinds: ['coder', 'tester-api'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        const testerStep = exec.steps.find((s) => s.agentKind === 'tester-api')!
        expect(testerStep.state).toBe('done')
        // The greenlit-but-failed report was rejected and looped the fixer exactly once before
        // the clean re-test greenlit — NOT accepted on the first round.
        expect(testerStep.test?.attempts).toBe(1)
        expect(testerStep.test?.lastReport?.greenlight).toBe(true)
      })

      it('fails the run (tester step left un-done) when the greenlight is withheld terminally', async () => {
        // A report with a blocking (critical) concern and NO PR branch for a fixer to
        // push to is terminal: the run FAILS and the tester step is left un-`done` (it
        // is never falsely marked complete on a failure). Also exercises the engine's
        // defensive override — a `greenlight:true` carrying a critical concern is still
        // withheld, so a buggy/over-eager report can't slip a blocker through.
        const bogusGreen = {
          greenlight: true,
          summary: 'shipped with a known crash',
          tested: ['login'],
          outcomes: [{ name: 'login', status: 'failed' as const, detail: 'crash' }],
          concerns: [{ title: 'NPE', detail: 'crashes on null', severity: 'critical' as const }],
        }
        const app = harness.makeApp({
          asyncKinds: ['tester-api', 'fixer'],
          asyncPolls: 1,
          testReports: [bogusGreen],
          // No pullRequest → no branch for the fixer to push to → terminal failure.
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Test only',
          agentKinds: ['tester-api'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('failed')
        const testerStep = exec.steps.find((s) => s.agentKind === 'tester-api')!
        expect(testerStep.state).not.toBe('done')
      })

      it('applies the task as a spec increment and ingests the spec-writer document', async () => {
        // The spec-writer step runs on the implementation branch BEFORE the coder,
        // applying ONLY this task's requirements as an increment onto the baseline spec
        // (no cross-task aggregation — an unmerged sibling task is invisible). Driving it
        // identically on both runtimes pins the strict ingest + artifact handoff so they
        // can't drift.
        const spec = {
          service: 'Auth',
          summary: 'Authentication service',
          modules: [
            {
              name: 'Access',
              summary: 'User access',
              groups: [
                {
                  name: 'Login',
                  requirements: [
                    {
                      id: 'req-login',
                      title: 'Login',
                      statement: 'The system SHALL let a user log in.',
                      kind: 'functional',
                      priority: 'must',
                      acceptance: [
                        {
                          id: 'ac-1',
                          given: 'a registered user',
                          when: 'they sign in',
                          outcome: 'a session starts',
                        },
                      ],
                    },
                  ],
                  rules: [],
                },
              ],
            },
          ],
        }
        const app = harness.makeApp({ spec })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Requirements only',
          agentKinds: ['spec-writer'],
        })
        expect(pipeline.status).toBe(201)

        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)

        const ticked = await app.drive(wsId)
        const exec = ticked.find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        const step = exec.steps.find((s) => s.agentKind === 'spec-writer')!
        expect(step.state).toBe('done')
        // The doc parsed + ingested cleanly, and the engine replaced the step's
        // reviewable output (the raw container transcript summary) with a rendering of
        // the SPEC ITSELF — the universal artifact-review handoff a companion grades.
        // Pinned on both runtimes so a facade can't drift back to surfacing the
        // transcript (which made the spec-companion loop on an "unreviewable" artifact).
        expect(step.output).not.toContain('[spec-writer]')
        expect(step.output).toContain('# Specification: Auth')
        expect(step.output).toContain('The system SHALL let a user log in.')
        expect(step.output).toContain(
          'GIVEN a registered user WHEN they sign in THEN a session starts',
        )
      })

      it('skips a disabled step at run start but keeps it in the saved pipeline', async () => {
        // A step the pipeline marks `enabled[i] === false` is kept in the saved
        // pipeline (so it can be toggled back on) but skipped when the run is built —
        // the execution instance contains only the enabled steps. Disabling the FIRST
        // step also exercises "the first SURVIVING step starts working". Driven on both
        // runtimes so the skip can't drift between the facades.
        const app = harness.makeApp({ confidence: 1 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Docs (researcher disabled)',
          agentKinds: ['researcher', 'documenter', 'integrator'],
          enabled: [false, true, true],
        })
        expect(pipeline.status).toBe(201)
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)
        const ticked = await app.drive(wsId)
        const exec = ticked.find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        // The disabled researcher never ran — the run is built only from the enabled
        // steps — while the saved pipeline still carries all three.
        expect(exec.steps.map((s) => s.agentKind)).toEqual(['documenter', 'integrator'])
        const saved = (
          await app.call<Pipeline[]>('GET', `/workspaces/${wsId}/pipelines`)
        ).body.find((p) => p.id === pipeline.body.id)!
        expect(saved.agentKinds).toEqual(['researcher', 'documenter', 'integrator'])
        expect(saved.enabled).toEqual([false, true, true])
      })

      it("substitutes a block's reworked requirements for its description in every step", async () => {
        // Once a task's requirements have been reworked ("incorporated"), that
        // standard-format document — not the raw description — is what every agent step
        // consumes. This must hold on EVERY runtime: the Cloudflare facade wires the D1
        // review store, the Node facade the Drizzle one, and both feed the engine through
        // the optional `requirementReviewRepository`. Asserting it here means a facade
        // that forgets to wire that store (the old Node gap) fails a shared test instead
        // of silently shipping divergent agent context.
        const REWORKED = '# Login — Requirements\n\nThe system SHALL keep sessions for 24h.'
        const app = harness.makeApp({ confidence: 1, echoDescription: true })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        await app.seedIncorporatedReview(wsId, 'task_login', REWORKED)

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Coder only',
          agentKinds: ['coder'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)

        const ticked = await app.drive(wsId)
        const exec = ticked.find((e) => e.blockId === 'task_login')!
        const step = exec.steps.find((s) => s.agentKind === 'coder')!
        expect(step.state).toBe('done')
        // The agent was handed the reworked document, not the seeded task's description.
        expect(step.output).toContain(`[desc]${REWORKED}[/desc]`)
      })

      it("substitutes a block's clarified bug report for its description in every step", async () => {
        // The clarity mirror of the requirements substitution above: once a bug task's
        // report has been triaged + clarified ("incorporated"), that clarified report — not
        // the raw description — is what every agent step consumes. This must hold on EVERY
        // runtime: the Cloudflare facade wires the D1 clarity store, the Node facade the
        // Drizzle one, both feeding the engine through the optional `clarityReviewRepository`.
        // A facade that forgets to wire that store fails this shared test.
        const CLARIFIED = '# Login — Bug Report\n\n## Steps to Reproduce\n1. POST /login twice.'
        const app = harness.makeApp({ confidence: 1, echoDescription: true })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        await app.seedIncorporatedClarityReview(wsId, 'task_login', CLARIFIED)

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Coder only',
          agentKinds: ['coder'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)

        const ticked = await app.drive(wsId)
        const exec = ticked.find((e) => e.blockId === 'task_login')!
        const step = exec.steps.find((s) => s.agentKind === 'coder')!
        expect(step.state).toBe('done')
        // The agent was handed the clarified report, not the seeded task's description.
        expect(step.output).toContain(`[desc]${CLARIFIED}[/desc]`)
      })

      it("folds an initiative preset's per-kind steering onto a spawned run's agent context", async () => {
        // D1: a task SPAWNED by an initiative (carrying `block.initiativeId`) must receive the
        // preset's standing per-kind methodology in its agent context on EVERY runtime — the
        // Cloudflare facade resolves it from the D1 initiative store, Node/local from Drizzle,
        // both through the same `AgentContextBuilder`. A facade that failed to wire the initiative
        // store into the context builder would silently ship a bare child prompt. The preset is
        // registered on a fresh app-owned registry injected via `makeApp` — the DI seam that
        // replaced the old module-global registration.
        const ADDITION = 'Follow the org connector architecture and consume the build handoff.'
        const initiativePresetRegistry = new InitiativePresetRegistry()
        initiativePresetRegistry.register({
          descriptor: {
            id: 'preset_spawned_conf',
            presentation: {
              label: 'Connector factory',
              icon: 'i',
              color: '#000',
              description: 'x',
            },
            fields: [],
            planningPipelineId: 'pl_initiative',
            interview: 'full',
            humanReviewDefault: true,
            defaultFragmentIds: [],
          },
          promptAdditions: { coder: ADDITION },
        })
        const app = harness.makeApp(
          { confidence: 1, echoPreset: true },
          { initiativePresetRegistry },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        // Seed the initiative entity anchored to an initiative block id, then link the seeded
        // task to it (an epic-style `initiativeId` membership — exactly what the loop's
        // `buildTaskBlock` stamps on a spawned child).
        const anchorBlockId = 'init_anchor'
        await app.initiativeRepository().insert(wsId, spawnedInitiative(anchorBlockId))
        await app.blockRepository().update(wsId, 'task_login', { initiativeId: anchorBlockId })

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Coder only',
          agentKinds: ['coder'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)

        const ticked = await app.drive(wsId)
        const exec = ticked.find((e) => e.blockId === 'task_login')!
        const step = exec.steps.find((s) => s.agentKind === 'coder')!
        expect(step.state).toBe('done')
        // The coder was handed the preset label + its `coder` promptAddition (and nothing else —
        // no goal/qa bleeds onto a spawned run).
        expect(step.output).toContain(`[preset]Connector factory|${ADDITION}[/preset]`)
      })

      it('serves an injected custom preset descriptor in the snapshot + accepts create-with-preset', async () => {
        // D5: the app-owned initiative-preset registry the facade injects surfaces the custom
        // preset in the workspace snapshot's `initiativePresets` (the SPA picker) AND is accepted
        // by create-initiative — identically on every runtime, replacing the module-global registry.
        const CUSTOM_ID = 'preset_conf_custom'
        const initiativePresetRegistry = new InitiativePresetRegistry()
        initiativePresetRegistry.register({
          descriptor: {
            id: CUSTOM_ID,
            presentation: {
              label: 'Conformance custom',
              icon: 'i-lucide-x',
              color: '#123456',
              description: 'A conformance-injected custom preset.',
            },
            fields: [{ key: 'toolName', label: 'Tool', type: 'text', required: true }],
            planningPipelineId: 'pl_initiative',
            interview: 'full',
            humanReviewDefault: true,
            defaultFragmentIds: [],
          },
        })
        const app = harness.makeApp({ confidence: 1 }, { initiativePresetRegistry })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        // The snapshot carries the injected descriptor (+ the built-in generic, always resolvable).
        const snapshot = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        const presetIds = (snapshot.body.initiativePresets ?? []).map((p) => p.id)
        expect(presetIds).toContain(CUSTOM_ID)
        expect(presetIds).toContain('preset_generic')

        // Create an initiative on the seeded service frame naming the injected preset — it is
        // accepted (an unknown preset id would be a create-time ValidationError). Anchor it to a
        // SEEDED service frame (`blk_auth`) rather than minting one over `POST /blocks`: raw
        // service-frame creation is deliberately off the mothership-mode SPA path (the mothership
        // persistence RPC does not proxy `serviceRepository.insert`), so a seeded frame keeps this
        // assertion — about preset acceptance, not frame creation — identical on every runtime.
        const created = await app.call('POST', `/workspaces/${wsId}/initiatives`, {
          frameId: 'blk_auth',
          title: 'Custom-preset initiative',
          presetId: CUSTOM_ID,
          presetInputs: { toolName: 'acme' },
        })
        expect(created.status).toBe(201)
      })

      it('restarts a run from a chosen step, preserving prior outputs and the block requirements', async () => {
        // "Restart from this step" re-runs the pipeline from a human-chosen step
        // (even on a finished run), keeping the earlier steps' outputs as handoff
        // context and resetting that step + every later one. The requirements a
        // restarted step receives must survive the restart: they live on the
        // requirement-review record, not the run, so a restarted spec-writer/coder
        // still reads the incorporated document. Driving it on BOTH runtimes pins the
        // restart endpoint + the handoff so neither facade can drift.
        const REWORKED = '# Login — Requirements\n\nSessions SHALL persist for 24h.'
        const app = harness.makeApp({ confidence: 1, echoDescription: true })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        await app.seedIncorporatedReview(wsId, 'task_login', REWORKED)

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Spec then code',
          agentKinds: ['spec-writer', 'coder'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)

        const firstRun = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(firstRun.status).toBe('done')
        expect(firstRun.steps.map((s) => s.state)).toEqual(['done', 'done'])
        const originalSpec = firstRun.steps[0]!.output
        expect(originalSpec).toContain('[spec-writer]')
        const originalCoder = firstRun.steps[1]!.output
        expect(originalCoder).toBeTruthy()

        // Restart from the LAST step (coder). The earlier spec-writer is preserved
        // untouched; the coder is reset to re-run. A fresh run id is minted and the
        // response comes back already running on the chosen step.
        const restarted = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/executions/${firstRun.id}/restart`,
          { fromStepIndex: 1 },
        )
        expect(restarted.status).toBe(200)
        expect(restarted.body.id).not.toBe(firstRun.id)
        expect(restarted.body.status).toBe('running')
        expect(restarted.body.currentStep).toBe(1)
        // Step 0 is preserved verbatim (output + done state are the handoff context).
        expect(restarted.body.steps[0]!.state).toBe('done')
        expect(restarted.body.steps[0]!.output).toBe(originalSpec)
        // Step 1 was reset (no stale output; re-running, not done).
        expect(restarted.body.steps[1]!.state).not.toBe('done')
        expect(restarted.body.steps[1]!.output).toBeFalsy()
        // The restart DISCARDED the coder's completed output; rather than losing it, the run
        // records it in an output history attributed to that step — so the step-detail
        // execution history can surface superseded SUCCESSFUL outputs, not only failures.
        expect(restarted.body.outputHistory).toEqual([
          expect.objectContaining({ stepIndex: 1, output: originalCoder }),
        ])

        const afterCoder = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(afterCoder.status).toBe('done')
        expect(afterCoder.id).toBe(restarted.body.id)
        // The restarted coder still received the block's incorporated requirements —
        // not the raw description — proving the restart preserved the requirements handoff.
        expect(afterCoder.steps[1]!.output).toContain(`[desc]${REWORKED}[/desc]`)

        // Restarting from step 0 re-runs the spec-writer itself, which must ALSO still
        // receive the incorporated requirements (the explicit spec-writer guarantee).
        const restartedHead = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/executions/${afterCoder.id}/restart`,
          { fromStepIndex: 0 },
        )
        expect(restartedHead.status).toBe(200)
        expect(restartedHead.body.currentStep).toBe(0)
        expect(restartedHead.body.steps.every((s) => s.state !== 'done')).toBe(true)

        const afterHead = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(afterHead.status).toBe('done')
        expect(afterHead.steps[0]!.output).toContain(`[desc]${REWORKED}[/desc]`)
        // The successful-output trail accumulates across restarts and round-trips through the
        // facade's persistence (it rides the run's `detail` JSON like the failure trail): the
        // first restart discarded the coder (step 1); the head restart then discarded the re-run
        // spec-writer (step 0) + coder (step 1) — each attributed to the step that produced it.
        expect(afterHead.outputHistory?.map((o) => o.stepIndex)).toEqual([1, 0, 1])
        expect(
          afterHead.outputHistory?.some((o) => o.stepIndex === 0 && o.output === originalSpec),
        ).toBe(true)

        // An out-of-range step index is rejected (422) rather than stranding the run.
        const bad = await app.call(
          'POST',
          `/workspaces/${wsId}/executions/${afterHead.id}/restart`,
          { fromStepIndex: 9 },
        )
        expect(bad.status).toBe(422)
      })

      it('wires the requirements-review re-review endpoint and rejects it out of order', async () => {
        // The dedicated review window resumes a parked run through bespoke endpoints
        // (re-review / proceed / resolve-exceeded) routed via the execution service. They
        // must be mounted on EVERY facade. A re-review is only valid once an incorporation
        // has produced a document (status `merged`); on a settled (`incorporated`) review
        // the guard rejects it with 409 BEFORE any model call — so this is deterministic
        // (no live reviewer) yet proves the route is wired and the guard holds identically.
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        await app.seedIncorporatedReview(wsId, 'task_login', '# Login — Requirements')

        const res = await app.call(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/requirement-review/re-review`,
        )
        expect(res.status).toBe(409)
      })

      it('wires the async-incorporate endpoint and refuses it while a finding is open', async () => {
        // Incorporation is asynchronous: the route records the human's intent on the parked
        // run and signals the durable driver to fold + re-review in the background. Its
        // pre-LLM guard — every finding must be answered or dismissed first — must hold on
        // EVERY facade and fires BEFORE any model call or run signal, so this is
        // deterministic (no live reviewer) yet proves the route is mounted identically and
        // the guard rejects an out-of-order incorporate. A `ready` review with one still-open
        // finding is seeded straight into each facade's real review store.
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        await app.seedReadyReview(wsId, 'task_login')

        const res = await app.call(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/requirement-review/incorporate`,
          {},
        )
        // The unanswered finding fails the guard (a `validation` domain error → 422) before
        // any model call or run signal — identically on both facades.
        expect(res.status).toBe(422)
      })

      // ---- Implementation-fork decision phase (Coder step) ----------------
      // The optional fork-decision phase surfaces materially different implementation
      // approaches before the Coder writes code and parks for a human choice. It rides the
      // coder step's `forkDecision` state (no side table), so the propose→park→choose→coder
      // loop, the single-path auto-advance, and the default pass-through must all behave
      // identically on every facade. The read-only `fork-proposer` is a structured kind, so
      // the shared fake returns `customResult` as its proposal — no real container needed.

      it('passes through (skips) the fork phase when the risk policy gate is off (the default)', async () => {
        // Tri-state `auto` + the built-in preset's DISABLED fork gating ⇒ never propose. The
        // Coder runs directly; the step records `skipped` and the run never parks. This is the
        // default every existing pipeline gets, so it must not regress.
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Code only',
          agentKinds: ['coder'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        const coder = exec.steps.find((s) => s.agentKind === 'coder')!
        expect(coder.state).toBe('done')
        expect(coder.output).toContain('[coder]')
        expect(coder.forkDecision?.status).toBe('skipped')
      })

      it('proposes, parks, and re-runs the Coder with the chosen fork folded in', async () => {
        // Tri-state `always` forces the phase; the structured proposer returns two materially
        // different forks (via `customResult`), so the run PARKS. The human reads the forks and
        // chooses one; the Coder then dispatches (Phase B) and the run completes.
        const app = harness.makeApp({
          customResult: {
            seamSummary: 'the login mapper seam',
            forks: [
              {
                title: 'Patch the call site',
                summary: 'targeted fix',
                approach: 'edit AuthController directly',
                tradeoffs: ['fast', 'localized'],
                recommended: true,
              },
              {
                title: 'Refactor the seam',
                summary: 'introduce an abstraction',
                approach: 'extract a SessionGateway',
                tradeoffs: ['cleaner', 'wider blast radius'],
              },
            ],
            singlePath: false,
          },
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const task = await app.call<Block>(
          'POST',
          `/workspaces/${wsId}/blocks/mod_sessions/tasks`,
          {
            title: 'Fork task',
            agentConfig: { 'coder.forkDecision': 'always' },
          },
        )
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Fork + code',
          agentKinds: ['coder'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/${task.body.id}/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)

        // Drive to the park: the coder step waits on the human's fork choice.
        const parked = (await app.drive(wsId)).find((e) => e.blockId === task.body.id)!
        expect(parked.status).toBe('blocked')
        const parkedCoder = parked.steps.find((s) => s.agentKind === 'coder')!
        expect(parkedCoder.state).toBe('waiting_decision')
        expect(parkedCoder.forkDecision?.status).toBe('awaiting_choice')
        expect(parkedCoder.forkDecision?.forks).toHaveLength(2)

        // The GET route returns the same live state.
        const view = await app.call<ForkDecisionStepState | null>(
          'GET',
          `/workspaces/${wsId}/executions/${parked.id}/fork-decision`,
        )
        expect(view.status).toBe(200)
        expect(view.body?.status).toBe('awaiting_choice')
        const chosenId = view.body!.forks![0]!.id

        // Choose a proposed fork; the run re-arms and the Coder dispatches (Phase B).
        const choose = await app.call<ForkDecisionStepState>(
          'POST',
          `/workspaces/${wsId}/executions/${parked.id}/fork-decision/choose`,
          { forkId: chosenId },
        )
        expect(choose.status).toBe(200)
        expect(choose.body.status).toBe('chosen')

        const done = (await app.drive(wsId)).find((e) => e.blockId === task.body.id)!
        expect(done.status).toBe('done')
        const finalCoder = done.steps.find((s) => s.agentKind === 'coder')!
        expect(finalCoder.state).toBe('done')
        expect(finalCoder.forkDecision?.status).toBe('chosen')
        expect(finalCoder.forkDecision?.chosen?.forkId).toBe(chosenId)
      })

      it('auto-advances a single path without parking', async () => {
        // The proposer's escape hatch (`singlePath`) fires for a trivial/obvious task: no park,
        // the Coder dispatches directly, and the step records `single_path`.
        const app = harness.makeApp({
          customResult: {
            seamSummary: 'obvious one-liner',
            forks: [],
            singlePath: true,
            singlePathReason: 'Any competent engineer would implement it the same way.',
          },
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const task = await app.call<Block>(
          'POST',
          `/workspaces/${wsId}/blocks/mod_sessions/tasks`,
          {
            title: 'Trivial fork task',
            agentConfig: { 'coder.forkDecision': 'always' },
          },
        )
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Fork + code (single path)',
          agentKinds: ['coder'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/${task.body.id}/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === task.body.id)!
        expect(exec.status).toBe('done')
        const coder = exec.steps.find((s) => s.agentKind === 'coder')!
        expect(coder.state).toBe('done')
        expect(coder.forkDecision?.status).toBe('single_path')
      })

      it('mounts the fork chat endpoint and degrades it identically when no model can run', async () => {
        // A human can chat about the surfaced forks before deciding. The chat rides the coder
        // step (no side table), and the reply is computed by an inline model IN THE DURABLE
        // DRIVER. In the suite no chat model can actually run (Node's default ref resolves to an
        // unregistered provider; Cloudflare's resolves its Workers-AI binding but the call can't
        // run in tests), so the responder must DEGRADE GRACEFULLY and IDENTICALLY: the route is
        // mounted on every facade, the human turn is recorded + the run re-parks `awaiting_choice`
        // with a canned assistant reply, and pick / custom still work — the divergence the
        // cross-runtime suite guards.
        const app = harness.makeApp({
          customResult: {
            seamSummary: 'the login mapper seam',
            forks: [
              {
                title: 'Patch the call site',
                summary: 's',
                approach: 'a1',
                tradeoffs: ['fast'],
                recommended: true,
              },
              { title: 'Refactor the seam', summary: 's', approach: 'a2', tradeoffs: ['clean'] },
            ],
            singlePath: false,
          },
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const task = await app.call<Block>(
          'POST',
          `/workspaces/${wsId}/blocks/mod_sessions/tasks`,
          {
            title: 'Fork chat task',
            agentConfig: { 'coder.forkDecision': 'always' },
          },
        )
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Fork chat + code',
          agentKinds: ['coder'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/${task.body.id}/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)
        const parked = (await app.drive(wsId)).find((e) => e.blockId === task.body.id)!
        expect(parked.status).toBe('blocked')

        // Send a chat message: the human turn is recorded immediately (status `answering`).
        const sent = await app.call<ForkDecisionStepState>(
          'POST',
          `/workspaces/${wsId}/executions/${parked.id}/fork-decision/chat`,
          { text: 'Which is safer?' },
        )
        expect(sent.status).toBe(200)
        expect(sent.body.status).toBe('answering')
        expect(sent.body.chat?.filter((m) => m.role === 'human')).toHaveLength(1)

        // The durable driver re-enters, computes the (canned, no-model) reply, and re-parks.
        const answered = (await app.drive(wsId)).find((e) => e.blockId === task.body.id)!
        expect(answered.status).toBe('blocked')
        const answeredCoder = answered.steps.find((s) => s.agentKind === 'coder')!
        expect(answeredCoder.forkDecision?.status).toBe('awaiting_choice')
        const answeredChat = answeredCoder.forkDecision?.chat ?? []
        expect(answeredChat.filter((m) => m.role === 'human')).toHaveLength(1)
        expect(answeredChat.filter((m) => m.role === 'assistant')).toHaveLength(1)

        // Choosing still works after the chat exchange: the Coder dispatches (Phase B).
        const chosenId = answeredCoder.forkDecision!.forks![0]!.id
        const choose = await app.call<ForkDecisionStepState>(
          'POST',
          `/workspaces/${wsId}/executions/${parked.id}/fork-decision/choose`,
          { forkId: chosenId },
        )
        expect(choose.status).toBe(200)
        expect(choose.body.status).toBe('chosen')
        const done = (await app.drive(wsId)).find((e) => e.blockId === task.body.id)!
        expect(done.status).toBe('done')
      })

      it('wires the async recommend endpoint and degrades it identically when the Writer cannot run', async () => {
        // Requesting Requirement-Writer recommendations appends `pending` placeholders and, on a
        // parked run, lets the durable driver fill them per finding; off-path (a `ready` review
        // seeded with no pipeline parked on it) the Writer runs inline. The route must be mounted
        // on EVERY facade and resolve through the same execution-service seam. In the suite no
        // reviewer model can actually run — Node's default ref resolves to an unregistered
        // provider, Cloudflare's resolves its Workers-AI binding but the call can't run in tests —
        // so the inline fill must DEGRADE GRACEFULLY and IDENTICALLY: drop the placeholder, reopen
        // the finding for manual answering, and return 200 with the review (NOT 500 on the runtime
        // whose resolve throws). The full happy-path Writer loop is covered by the orchestration
        // unit tests, which a fake model can drive.
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        await app.seedReadyReview(wsId, 'task_login')

        const res = await app.call<RequirementReview>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/requirement-review/recommend`,
          { items: [{ itemId: 'rri_seed_task_login' }] },
        )
        expect(res.status).toBe(200)
        // The Writer couldn't run, so no recommendation survives and the finding is back to `open`
        // for the human to answer by hand — the same end state on both runtimes.
        expect(res.body.recommendations).toEqual([])
        expect(res.body.items.find((i) => i.id === 'rri_seed_task_login')?.status).toBe('open')
      })

      it('passes a companion gate when the rating clears the threshold', async () => {
        // A companion step grades the prior producer; at/above its threshold the run
        // proceeds. `reviewer` is the coder's companion, so ['coder','reviewer'] runs the
        // coder then grades it — a passing rating (default 1) finishes the run.
        const app = harness.makeApp({ confidence: 1 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + companion',
          agentKinds: ['coder', 'reviewer'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)
        const ticked = await app.drive(wsId)
        const exec = ticked.find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        const companionStep = exec.steps.find((s) => s.agentKind === 'reviewer')!
        const verdict = companionStep.companion?.verdicts.at(-1)
        expect(verdict?.rating).toBe(1)
        expect(verdict?.passed).toBe(true)
      })

      it('always loops the producer on the FIRST batch when the review raised comments, even above threshold', async () => {
        // First review batch: ANY comments loop the producer back regardless of rating —
        // so the first round of findings is always handed to the implementer. The
        // threshold only governs the SECOND pass onward. A steady 0.85 (above the 0.8
        // bar) WITH comments therefore loops once, then passes the second grade.
        const app = harness.makeApp({ confidence: 1, companionRatings: [0.85, 0.85] })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + first-batch companion',
          agentKinds: ['coder', 'reviewer'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        const companionStep = exec.steps.find((s) => s.agentKind === 'reviewer')!
        // First batch failed despite clearing the threshold (forced loop), second passed.
        expect(companionStep.companion?.verdicts.map((v) => v.passed)).toEqual([false, true])
        expect(companionStep.companion?.verdicts.every((v) => v.rating === 0.85)).toBe(true)
        expect(companionStep.companion?.attempts).toBe(1)
      })

      it('fails the run when a companion verdict cannot be parsed (no silent 100% pass)', async () => {
        // The bug: a truncated/malformed reviewer reply was silently treated as a perfect
        // pass (rating 1 ≥ threshold) and the real review was dropped. Now an unparseable
        // verdict — even after the repair retry — fails the run for human attention.
        const app = harness.makeApp({ confidence: 1, companionMalformed: true })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + unparseable companion',
          agentKinds: ['coder', 'reviewer'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('failed')
        expect(exec.failure?.kind).toBe('companion_rejected')
        // The RICH failure record survives the drive: the driver funnels the inline gate's
        // `job_failed` through the single `failRun` with the gate's own kind/message/detail,
        // and never re-fails the (already-failed) run with a generic record. Guards the
        // regression where a second `failRun` clobbered this with kind `job_failed`,
        // message "companion_rejected" and a misleading "container reported a failure" hint.
        expect(exec.failure?.message).toContain('did not return a parseable assessment')
        // The companion's raw (unparseable) reply is stored as the detail for triage —
        // the whole point of the failure, lost when the record was clobbered.
        expect(exec.failure?.detail).toContain('my reply got cut off')
        // The companion step was NOT marked done / passed off as a clean review.
        const companionStep = exec.steps.find((s) => s.agentKind === 'reviewer')!
        expect(companionStep.state).not.toBe('done')
      })

      it('classifies a container-start (dispatch) failure as `dispatch`, not a generic run failure', async () => {
        // When the container/runner never accepts the job (startJob throws), the engine
        // must classify it as a `dispatch` failure ("Container failed to start") and carry
        // the verbatim provider error as the detail — identically on both runtimes — rather
        // than a generic "Run failed" with a misleading "inspect the container logs" hint.
        const app = harness.makeApp({
          asyncKinds: ['coder'],
          dispatchThrowKinds: ['coder'],
          dispatchThrowMessage: 'Container dispatch failed (HTTP 503): no capacity',
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build only',
          agentKinds: ['coder'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('failed')
        expect(exec.failure?.kind).toBe('dispatch')
        // The verbatim provider/runtime response is preserved as the detail for triage.
        expect(exec.failure?.detail).toContain('HTTP 503')
        // The step did not falsely complete; the container is surfaced as errored (the
        // details say the container failed to start, not a generic "run failed").
        const coderStep = exec.steps.find((s) => s.agentKind === 'coder')!
        expect(coderStep.state).not.toBe('done')
        expect(coderStep.container?.status).toBe('errored')
      })

      it("maps a polled job's structured failureCause → AgentFailureKind and surfaces the detail", async () => {
        // The harness now reports a STRUCTURED `failureCause` (+ extended `detail`) on a failed
        // job view; the engine must classify the failure from it WITHOUT regex-matching the error
        // — a watchdog `inactivity-timeout` becomes `timeout`, and the harness detail is surfaced.
        // Asserted identically on both runtimes so a facade/transport that drops the cause (the
        // way the Node pool transport once did) fails here instead of silently degrading to `agent`.
        const app = harness.makeApp({
          asyncKinds: ['coder'],
          pollFailKinds: ['coder'],
          pollFailCause: 'inactivity-timeout',
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build only',
          agentKinds: ['coder'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('failed')
        // The watchdog cause classifies as `timeout`, not the generic `agent`.
        expect(exec.failure?.kind).toBe('timeout')
        // The harness's extended diagnostic is surfaced as the failure detail.
        expect(exec.failure?.detail).toContain('Phase timings')
        // The step's container is surfaced as errored (the run details show the container
        // faulted), persisted before the failure funnels through `failRun`.
        const coderStep = exec.steps.find((s) => s.agentKind === 'coder')!
        expect(coderStep.container?.status).toBe('errored')
      })

      it('routes a merger PR to human review when the assessment is unexplained (empty rationale)', async () => {
        // Engine guard: auto-merge only on a CREDIBLE within-threshold assessment. Scores
        // within every ceiling but an EMPTY rationale (the shape a merger that failed to
        // examine the diff degrades to) must NOT silently merge — it routes to merge_review
        // and the task is left pr_ready, never `done`.
        const app = harness.makeApp({
          confidence: 1,
          mergeAssessment: { complexity: 0, risk: 0, impact: 0, rationale: '' },
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + merger',
          agentKinds: ['coder', 'merger'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)
        const ticked = await app.drive(wsId)
        const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
        const task = snap.blocks.find((b) => b.id === 'task_login')!
        expect(task.status).toBe('pr_ready')
        expect(task.status).not.toBe('done')
        // The engine records its structured decision on the merger step (`step.custom`) so
        // the SPA can explain WHY review was needed — here, an assessment WITH scores but no
        // rationale routes to review as `no_rationale` (distinct from a truly absent one),
        // not an auto-merge.
        const exec = ticked.find((e) => e.blockId === 'task_login')!
        const decision = exec.steps.find((s) => s.agentKind === 'merger')!.custom as {
          outcome?: string
          reason?: string
        }
        expect(decision.outcome).toBe('awaiting_review')
        expect(decision.reason).toBe('no_rationale')
      })

      it('runs the merger merge at its step even when a later step follows it', async () => {
        // Regression guard for the parity-critical bug where a step AFTER `merger` silently
        // disabled auto-merge: the real merge is a DETERMINISTIC post-completion resolver
        // registered on the `merger` kind, so it fires when the MERGER STEP finishes — not
        // only when the merger happens to be the pipeline's last step. With a credible
        // within-threshold assessment the task must reach `done` even though a trailing
        // pass-through gate follows. (The original trailing step was `post-release-health`;
        // that gate is now opt-in + observability-gated, so the unwired `ci` gate — likewise
        // a pass-through here — stands in as the trailing step.)
        const app = harness.makeApp({
          confidence: 1,
          mergeAssessment: {
            complexity: 0,
            risk: 0,
            impact: 0,
            rationale: 'Trivial, well-tested change.',
          },
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + merger + trailing gate',
          agentKinds: ['coder', 'merger', 'ci'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)
        const ticked = await app.drive(wsId)
        const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
        const task = snap.blocks.find((b) => b.id === 'task_login')!
        // The merge ran at the (non-final) merger step → the block is `done`, not left
        // unmerged as `pr_ready`.
        expect(task.status).toBe('done')
        // The auto-merge decision is recorded on the merger step for the SPA to render.
        const exec = ticked.find((e) => e.blockId === 'task_login')!
        const decision = exec.steps.find((s) => s.agentKind === 'merger')!.custom as {
          outcome?: string
          reason?: string
          thresholds?: { presetName?: string }
        }
        expect(decision.outcome).toBe('auto_merged')
        expect(decision.reason).toBe('within_thresholds')
        expect(decision.thresholds?.presetName).toBeTruthy()
      })

      it('never auto-merges a task pinned to a "human review only" preset, even on a credible within-threshold assessment', async () => {
        // The "Manual review only" built-in preset (`autoMergeEnabled: false`) is the
        // human-review-only policy: a task pinned to it must ALWAYS route its PR to a human,
        // regardless of how low the assessment scores are. This drives the full task-threshold
        // wiring end-to-end — `block.riskPolicyId` → `resolveRiskPolicy` repository lookup →
        // `MergeResolver` — which the resolver unit test can't (it injects the preset directly).
        // A maximally-mergeable assessment (0/0/0 + a real rationale) would auto-merge under the
        // default preset; here it must NOT, proving the pinned preset — not the default — governs.
        const app = harness.makeApp({
          confidence: 1,
          mergeAssessment: {
            complexity: 0,
            risk: 0,
            impact: 0,
            rationale: 'Trivial, well-tested change.',
          },
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        // Listing the catalog lazily seeds the built-ins so `mp_manual_review` is a real row the
        // task can pin (the resolver reads it back via the repository, which does not self-seed).
        const presets = await app.call<RiskPolicy[]>('GET', `/workspaces/${wsId}/risk-policies`)
        expect(presets.body.some((p) => p.id === 'mp_manual_review')).toBe(true)
        // Pin the human-review-only preset on the task.
        await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
          riskPolicyId: 'mp_manual_review',
        })
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + merger',
          agentKinds: ['coder', 'merger'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)
        const ticked = await app.drive(wsId)
        const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
        const task = snap.blocks.find((b) => b.id === 'task_login')!
        // Human review only: the PR is left open for a human — never auto-merged.
        expect(task.status).toBe('pr_ready')
        expect(task.status).not.toBe('done')
        // The recorded decision names the pinned preset and the disabled-auto-merge reason so the
        // SPA banner is precise (distinct from an over-threshold `exceeded_thresholds`).
        const exec = ticked.find((e) => e.blockId === 'task_login')!
        const decision = exec.steps.find((s) => s.agentKind === 'merger')!.custom as {
          outcome?: string
          reason?: string
          thresholds?: { presetName?: string; autoMergeEnabled?: boolean }
        }
        expect(decision.outcome).toBe('awaiting_review')
        expect(decision.reason).toBe('auto_merge_disabled')
        expect(decision.thresholds?.presetName).toBe('Manual review only')
        expect(decision.thresholds?.autoMergeEnabled).toBe(false)
      })

      it('routes to human review when a task pinned to a strict preset gets an over-threshold assessment', async () => {
        // The auto-merge ceilings a task's PICKED preset carries must actually gate the merge —
        // not just the workspace default. Pin a custom strict preset (low ceilings) and return an
        // assessment that clears the default's ceilings but exceeds the strict one's: the merge
        // must be blocked, proving the pinned preset's thresholds — resolved via the repository —
        // are the ones compared, and the exceeded axes are reported precisely.
        const app = harness.makeApp({
          confidence: 1,
          mergeAssessment: {
            complexity: 0.45,
            risk: 0.1,
            impact: 0.45,
            rationale: 'Touches several modules with moderate coupling.',
          },
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const strict = await app.call<RiskPolicy>('POST', `/workspaces/${wsId}/risk-policies`, {
          name: 'Strict',
          maxComplexity: 0.3,
          maxRisk: 0.3,
          maxImpact: 0.3,
          ciMaxAttempts: 10,
          maxRequirementIterations: 6,
          maxRequirementConcernAllowed: 'none',
        })
        expect(strict.status).toBe(201)
        await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
          riskPolicyId: strict.body.id,
        })
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + merger',
          agentKinds: ['coder', 'merger'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)
        const ticked = await app.drive(wsId)
        const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
        const task = snap.blocks.find((b) => b.id === 'task_login')!
        expect(task.status).toBe('pr_ready')
        expect(task.status).not.toBe('done')
        const exec = ticked.find((e) => e.blockId === 'task_login')!
        const decision = exec.steps.find((s) => s.agentKind === 'merger')!.custom as {
          outcome?: string
          reason?: string
          exceededAxes?: string[]
          thresholds?: { presetName?: string }
        }
        expect(decision.outcome).toBe('awaiting_review')
        expect(decision.reason).toBe('exceeded_thresholds')
        // complexity (0.45) and impact (0.45) clear the default (0.5) but exceed the strict 0.3;
        // risk (0.1) is within — so only the two breaching axes are reported.
        expect(decision.exceededAxes?.sort()).toEqual(['complexity', 'impact'])
        expect(decision.thresholds?.presetName).toBe('Strict')
      })

      it('parks for a human when a companion spends its rework budget (no longer fails)', async () => {
        // Below the threshold the companion loops the producer back for automatic rework;
        // once the budget is spent the run no longer fails — it PARKS on the shared
        // iteration-cap gate for a human (one more round / proceed / stop & reset),
        // mirroring the requirements reviewer at its cap. A fixed low rating drives
        // straight to the cap on both runtimes.
        const app = harness.makeApp({ confidence: 1, companionRating: 0.4 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + strict companion',
          agentKinds: ['coder', 'reviewer'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)
        const ticked = await app.drive(wsId)
        const exec = ticked.find((e) => e.blockId === 'task_login')!
        // Parked, not failed.
        expect(exec.status).toBe('blocked')
        expect(exec.failure).toBeFalsy()
        const companionStep = exec.steps.find((s) => s.agentKind === 'reviewer')!
        expect(companionStep.state).toBe('waiting_decision')
        expect(companionStep.approval?.status).toBe('pending')
        expect(companionStep.companion?.exceeded).toBe(true)
        // The full automatic budget was spent before parking, and the recorded verdicts
        // carry the critic's REAL low rating (not the pass-through `1` for an unparseable
        // assessment). The fake critic emits anchor-based comments (no `quotedSource`),
        // so this also guards that `stepReviewCommentSchema` accepts the real shape.
        expect(companionStep.companion?.attempts).toBe(companionStep.companion?.maxAttempts)
        expect(companionStep.companion?.verdicts.every((v) => v.rating === 0.4)).toBe(true)
        expect(companionStep.companion?.verdicts.at(-1)?.passed).toBe(false)

        // The generic approve resolver can't short-circuit the iteration-cap gate.
        const stray = await app.call(
          'POST',
          `/workspaces/${wsId}/executions/${exec.id}/steps/${companionStep.approval!.id}/approve`,
          {},
        )
        expect(stray.status).toBe(409)
      })

      it('grants one more round at the companion cap, then completes when it passes', async () => {
        // `extra-round` raises the budget by one and loops the producer back through the
        // companion to re-grade. Four low grades drive to the cap; the post-extra-round
        // grade passes, so the run completes — proving the human can rescue a stuck run.
        const app = harness.makeApp({
          confidence: 1,
          companionRatings: [0.4, 0.4, 0.4, 0.4, 1],
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + rescued companion',
          agentKinds: ['coder', 'reviewer'],
        })
        await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        const parked = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(parked.status).toBe('blocked')
        const gate = parked.steps.find((s) => s.agentKind === 'reviewer')!
        const budgetAtCap = gate.companion!.maxAttempts

        const res = await app.call(
          'POST',
          `/workspaces/${wsId}/executions/${parked.id}/steps/${gate.approval!.id}/resolve-exceeded`,
          { choice: 'extra-round' },
        )
        expect(res.status).toBe(200)

        const done = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(done.status).toBe('done')
        const companionStep = done.steps.find((s) => s.agentKind === 'reviewer')!
        // The budget was raised by exactly one and the gate is no longer flagged exceeded.
        expect(companionStep.companion?.maxAttempts).toBe(budgetAtCap + 1)
        expect(companionStep.companion?.exceeded).toBeFalsy()
        expect(companionStep.companion?.verdicts.at(-1)?.passed).toBe(true)
      })

      it('proceeds past the companion cap, advancing with the current output', async () => {
        // `proceed` accepts the producer's current (below-bar) output and advances past
        // the gate; since the companion is the final step, the run completes.
        const app = harness.makeApp({ confidence: 1, companionRating: 0.4 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + proceed companion',
          agentKinds: ['coder', 'reviewer'],
        })
        await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        const parked = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        const gate = parked.steps.find((s) => s.agentKind === 'reviewer')!

        const res = await app.call(
          'POST',
          `/workspaces/${wsId}/executions/${parked.id}/steps/${gate.approval!.id}/resolve-exceeded`,
          { choice: 'proceed' },
        )
        expect(res.status).toBe(200)

        const done = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(done.status).toBe('done')
        const companionStep = done.steps.find((s) => s.agentKind === 'reviewer')!
        expect(companionStep.state).toBe('done')
        expect(companionStep.companion?.exceeded).toBeFalsy()
      })

      it('stops and resets the task to phase zero at the companion cap', async () => {
        // `stop-reset` tears the run down and returns the block to `planned` (editable),
        // identical to the requirements gate's stop-reset — the same `cancel()` path.
        const app = harness.makeApp({ confidence: 1, companionRating: 0.4 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + reset companion',
          agentKinds: ['coder', 'reviewer'],
        })
        await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        const parked = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        const gate = parked.steps.find((s) => s.agentKind === 'reviewer')!

        const res = await app.call(
          'POST',
          `/workspaces/${wsId}/executions/${parked.id}/steps/${gate.approval!.id}/resolve-exceeded`,
          { choice: 'stop-reset' },
        )
        expect(res.status).toBe(200)

        const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
        const task = snap.blocks.find((b) => b.id === 'task_login')!
        expect(task.status).toBe('planned')
        // The run record is gone — the task is back to phase zero, editable.
        expect(snap.executions.some((e) => e.blockId === 'task_login')).toBe(false)
      })

      it('rejects a companion separated from its producer by another step (strict adjacency)', async () => {
        // A companion must run IMMEDIATELY after a producer it can review — the builder
        // surfaces companions as toggles attached to their producer, and the validation
        // enforces that adjacency on EVERY facade. ['coder','tester-api','reviewer'] slips
        // `tester` between the coder and its `reviewer` companion, so the pipeline save is
        // rejected (a `validation` domain error → 422) before any run is created.
        const app = harness.makeApp({ confidence: 1 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const res = await app.call('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + gap companion',
          agentKinds: ['coder', 'tester-api', 'reviewer'],
        })
        expect(res.status).toBe(422)
      })

      it('skips an estimate-gated companion below threshold, runs it above', async () => {
        // A companion can be GATED on the task estimate: it runs only when the estimate
        // clears a threshold (OR across axes), else it is transparently skipped at runtime.
        // The estimate is produced by an earlier `task-estimator` step in the SAME run. A
        // LOW estimate skips the reviewer; the run still completes.
        const gating = [null, null, { enabled: true, minRisk: 0.6, minImpact: 0.6 }]
        const low = harness.makeApp({
          confidence: 1,
          taskEstimate: { complexity: 0.1, risk: 0.1, impact: 0.1, rationale: 'low' },
        })
        const { workspace } = await low.createWorkspace()
        const lowPipe = await low.call<Pipeline>('POST', `/workspaces/${workspace.id}/pipelines`, {
          name: 'Estimator-gated reviewer (low)',
          agentKinds: ['task-estimator', 'coder', 'reviewer'],
          gating,
        })
        expect(lowPipe.status).toBe(201)
        const lowStart = await low.call<ExecutionInstance>(
          'POST',
          `/workspaces/${workspace.id}/blocks/task_login/executions`,
          { pipelineId: lowPipe.body.id },
        )
        expect(lowStart.status).toBe(201)
        const lowExec = (await low.drive(workspace.id)).find((e) => e.blockId === 'task_login')!
        expect(lowExec.status).toBe('done')
        const skipped = lowExec.steps.find((s) => s.agentKind === 'reviewer')!
        expect(skipped.skipped).toBe(true)
        expect(skipped.companion?.verdicts ?? []).toEqual([])

        // A HIGH estimate clears the gate, so the reviewer runs and grades the coder.
        const high = harness.makeApp({
          confidence: 1,
          taskEstimate: { complexity: 0.9, risk: 0.9, impact: 0.9, rationale: 'high' },
        })
        const { workspace: ws2 } = await high.createWorkspace()
        const hiPipe = await high.call<Pipeline>('POST', `/workspaces/${ws2.id}/pipelines`, {
          name: 'Estimator-gated reviewer (high)',
          agentKinds: ['task-estimator', 'coder', 'reviewer'],
          gating,
        })
        const hiStart = await high.call<ExecutionInstance>(
          'POST',
          `/workspaces/${ws2.id}/blocks/task_login/executions`,
          { pipelineId: hiPipe.body.id },
        )
        expect(hiStart.status).toBe(201)
        const hiExec = (await high.drive(ws2.id)).find((e) => e.blockId === 'task_login')!
        expect(hiExec.status).toBe('done')
        const ran = hiExec.steps.find((s) => s.agentKind === 'reviewer')!
        expect(ran.skipped ?? false).toBe(false)
        expect((ran.companion?.verdicts.length ?? 0) > 0).toBe(true)
      })

      it('rejects a pipeline that gates a step with no task-estimator before it', async () => {
        // Estimate gating is meaningless without an estimate to consult, so a pipeline with
        // any enabled gating but no preceding `task-estimator` is rejected at save (and at
        // start) — a `validation` domain error → 422, identically on both facades.
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const res = await app.call('POST', `/workspaces/${workspace.id}/pipelines`, {
          name: 'Gated without estimator',
          agentKinds: ['coder', 'reviewer'],
          gating: [null, { enabled: true, minRisk: 0.6 }],
        })
        expect(res.status).toBe(422)
      })

      it('round-trips pipeline labels + archive state through create and organize', async () => {
        // Labels + archive are organizational metadata that persist on BOTH stores. Archive
        // is the only mutation a built-in accepts (it touches the view, not the structure).
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const created = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Labelled',
          agentKinds: ['coder'],
          labels: ['experiment', 'wip'],
        })
        expect(created.status).toBe(201)
        expect([...(created.body.labels ?? [])].sort()).toEqual(['experiment', 'wip'])
        expect(created.body.archived ?? false).toBe(false)

        const organized = await app.call<Pipeline>(
          'PATCH',
          `/workspaces/${wsId}/pipelines/${created.body.id}/organize`,
          { archived: true, labels: ['shelved'] },
        )
        expect(organized.status).toBe(200)
        expect(organized.body.archived).toBe(true)
        expect(organized.body.labels).toEqual(['shelved'])

        // The list reflects the persisted change (re-read from the store).
        const list = await app.call<Pipeline[]>('GET', `/workspaces/${wsId}/pipelines`)
        const reread = list.body.find((p) => p.id === created.body.id)!
        expect(reread.archived).toBe(true)
        expect(reread.labels).toEqual(['shelved'])

        // A built-in accepts organize (archive) while staying read-only/builtin.
        const builtin = list.body.find((p) => p.builtin)!
        const archivedBuiltin = await app.call<Pipeline>(
          'PATCH',
          `/workspaces/${wsId}/pipelines/${builtin.id}/organize`,
          { archived: true },
        )
        expect(archivedBuiltin.status).toBe(200)
        expect(archivedBuiltin.body.archived).toBe(true)
        expect(archivedBuiltin.body.builtin).toBe(true)
      })

      it('round-trips pipeline launch availability through create, update, and clone', async () => {
        // `availability` gates HOW a pipeline may be launched (one-off / recurring / both). It is
        // a plain persisted column on BOTH stores — a facade that forgot to map it would silently
        // drop the field on save (the exact gap this asserts against), leaving the launch gate
        // inert after a DB round-trip.
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const created = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Recurring only',
          agentKinds: ['coder'],
          availability: 'recurring',
        })
        expect(created.status).toBe(201)
        expect(created.body.availability).toBe('recurring')

        // Re-read from the store (not the create echo) — this is where a dropped column shows up.
        const afterCreate = await app.call<Pipeline[]>('GET', `/workspaces/${wsId}/pipelines`)
        expect(afterCreate.body.find((p) => p.id === created.body.id)?.availability).toBe(
          'recurring',
        )

        const updated = await app.call<Pipeline>(
          'PATCH',
          `/workspaces/${wsId}/pipelines/${created.body.id}`,
          { availability: 'both' },
        )
        expect(updated.status).toBe(200)
        expect(updated.body.availability).toBe('both')
        const afterUpdate = await app.call<Pipeline[]>('GET', `/workspaces/${wsId}/pipelines`)
        expect(afterUpdate.body.find((p) => p.id === created.body.id)?.availability).toBe('both')

        // A clone preserves the source's availability.
        const source = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'One-off only',
          agentKinds: ['coder'],
          availability: 'one-off',
        })
        expect(source.status).toBe(201)
        const cloned = await app.call<Pipeline>(
          'POST',
          `/workspaces/${wsId}/pipelines/${source.body.id}/clone`,
          {},
        )
        expect(cloned.status).toBe(201)
        expect(cloned.body.availability).toBe('one-off')
        const afterClone = await app.call<Pipeline[]>('GET', `/workspaces/${wsId}/pipelines`)
        expect(afterClone.body.find((p) => p.id === cloned.body.id)?.availability).toBe('one-off')
      })

      it('reviews the spec-writer with its companion and reworks it without a human gate', async () => {
        // The Spec Writer is no longer human-gated by default: its `spec-companion`
        // (Spec Reviewer) rates the spec, and below threshold loops the spec-writer
        // back for automatic rework — NO human decision is raised. A first failing
        // grade then a passing re-grade drives the loop to completion, pinning that
        // the spec quality gate is automatic on both runtimes.
        const spec = {
          service: 'Auth',
          summary: 'Authentication service',
          modules: [
            {
              name: 'Access',
              summary: 'User access',
              groups: [
                {
                  name: 'Login',
                  requirements: [
                    {
                      id: 'req-login',
                      title: 'Login',
                      statement: 'The system SHALL let a user log in.',
                      kind: 'functional',
                      priority: 'must',
                      acceptance: [
                        {
                          id: 'ac-1',
                          given: 'a registered user',
                          when: 'they sign in',
                          outcome: 'a session starts',
                        },
                      ],
                    },
                  ],
                  rules: [],
                },
              ],
            },
          ],
        }
        const app = harness.makeApp({ spec, companionRatings: [0.4, 1] })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Spec + reviewer',
          agentKinds: ['spec-writer', 'spec-companion'],
        })
        expect(pipeline.status).toBe(201)
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)
        const ticked = await app.drive(wsId)
        const exec = ticked.find((e) => e.blockId === 'task_login')!
        // Completed straight through — the spec never paused for a human decision.
        expect(exec.status).toBe('done')
        expect(exec.steps.some((s) => s.state === 'waiting_decision')).toBe(false)
        // The spec-writer re-ran after the failing grade and finished.
        expect(exec.steps.find((s) => s.agentKind === 'spec-writer')!.state).toBe('done')
        // The companion recorded both cycles (rejected then passed), consuming exactly
        // one automatic rework from the budget.
        const companionStep = exec.steps.find((s) => s.agentKind === 'spec-companion')!
        expect(companionStep.companion?.verdicts.map((v) => v.passed)).toEqual([false, true])
        expect(companionStep.companion?.attempts).toBe(1)
      })

      it('drives an asynchronous (polled) agent job to completion', async () => {
        // The `coder` step runs as a polled async job (startJob → awaiting_job → pollJob),
        // so this exercises the durable driver's job-poll loop — Cloudflare Workflows and
        // pg-boss — through the SAME assertion, the path most likely to drift between them.
        // asyncPolls: 3 so the job reports two running polls — phase `clone` then `agent`
        // — exercising the live phase progression surfaced on the step's container.
        const app = harness.makeApp({ confidence: 1, asyncKinds: ['coder'], asyncPolls: 3 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: 'pl_quick' },
        )
        expect(start.status).toBe(201)

        const ticked = await app.drive(wsId)
        const exec = ticked.find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        expect(exec.steps.every((s) => s.state === 'done')).toBe(true)
        // The coder step ran as a polled job but still produced its normal work product.
        const coder = exec.steps.find((s) => s.agentKind === 'coder')!
        expect(coder.output).toContain('[coder]')
        expect(coder.model).toBe('fake')
        // The container reached `up` (the cold-boot lifecycle advanced past `starting`),
        // and a finished job never reads as still booting.
        expect(coder.container?.status).toBe('up')
        // The model is known at dispatch (the moment the ref resolves, before the
        // container is up), so it must ALREADY be present on the first "spinning up
        // container" emit (container `starting`) — not only once the job's result lands.
        const containerEmits = app
          .executionEmits('task_login')
          .map((e) => e.steps.find((s) => s.agentKind === 'coder'))
        const booting = containerEmits.find((s) => s?.container?.status === 'starting')
        expect(booting, 'expected a "spinning up container" emit for the coder step').toBeTruthy()
        expect(booting!.model).toBe('fake')
        // Once up, the run surfaces the live phase (the agent making calls) and the
        // container's id, so the details show WHAT it's doing and WHERE it runs rather
        // than a blank "working" — identically on both runtimes.
        const running = containerEmits.find(
          (s) => s?.container?.status === 'up' && s.container.phase === 'agent',
        )
        expect(running, 'expected a running emit with the agent phase').toBeTruthy()
        expect(running!.container!.id).toContain('fake-container-')

        const task = (
          await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        ).body.blocks.find((b) => b.id === 'task_login')!
        expect(task.status).toBe('done')
      })

      it('parks on undecided follow-ups, then decides + loops the Coder (Follow-up companion)', async () => {
        // The async `coder` streams two forward-looking items (a follow-up + a question).
        // The engine appends them to the step live and the Follow-up companion gate holds the
        // pipeline at the Coder's completion until every item is decided — then loops the
        // Coder for the answered question before advancing. Asserted identically on both
        // runtimes (pure engine + step state — no new table, no facade-specific wiring).
        const app = harness.makeApp({
          confidence: 1,
          asyncKinds: ['coder'],
          followUps: [
            { kind: 'follow_up', title: 'Dedupe the retry helper', detail: 'two copies exist' },
            { kind: 'question', title: 'Which timeout?', detail: '30s or 60s?' },
          ],
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: 'pl_quick',
        })

        // The run parks at the Coder's completion: both items surfaced + pending, the run
        // blocked, and the NEXT step (blueprints) NOT started.
        const parked = await app.drive(wsId)
        const exec = parked.find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('blocked')
        const coder = exec.steps.find((s) => s.agentKind === 'coder')!
        expect(coder.followUps?.enabled).toBe(true)
        expect(coder.followUps?.items.map((i) => i.status)).toEqual(['pending', 'pending'])
        expect(exec.steps.find((s) => s.agentKind === 'blueprints')!.state).toBe('pending')

        // GET surfaces the same live state.
        const got = await app.call('GET', `/workspaces/${wsId}/executions/${exec.id}/follow-ups`)
        expect(got.status).toBe(200)

        const followUp = coder.followUps!.items.find((i) => i.kind === 'follow_up')!
        const question = coder.followUps!.items.find((i) => i.kind === 'question')!

        // Dismiss the follow-up, then answer the question → every item decided.
        await app.call(
          'POST',
          `/workspaces/${wsId}/executions/${exec.id}/follow-ups/${followUp.id}/dismiss`,
        )
        const answered = await app.call(
          'POST',
          `/workspaces/${wsId}/executions/${exec.id}/follow-ups/${question.id}/answer`,
          { answer: '30s' },
        )
        expect(answered.status).toBe(200)

        // The answered question loops the Coder once, then the run advances to completion.
        const done = await app.drive(wsId)
        const final = done.find((e) => e.blockId === 'task_login')!
        expect(final.status).toBe('done')
        const finalCoder = final.steps.find((s) => s.agentKind === 'coder')!
        expect(finalCoder.followUps?.loops ?? 0).toBeGreaterThanOrEqual(1)
        expect(finalCoder.followUps?.items.find((i) => i.id === question.id)?.status).toBe(
          'answered',
        )
      })

      it('opens a PR when confidence is below threshold, then merges on demand', async () => {
        const app = harness.makeApp({ confidence: 0.5 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: 'pl_quick',
        })
        await app.drive(wsId)

        const task = (
          await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        ).body.blocks.find((b) => b.id === 'task_login')!
        expect(task.status).toBe('pr_ready')
        expect(task.confidence).toBe(0.5)

        const merge = await app.call<{ status: string }>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/merge`,
        )
        expect(merge.status).toBe(200)
        expect(merge.body.status).toBe('done')
      })

      it('rejects merging a block with no open PR', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const res = await app.call('POST', `/workspaces/${workspace.id}/blocks/task_login/merge`)
        expect(res.status).toBe(409)
      })

      it('pauses for a human decision and resumes after it is resolved', async () => {
        const app = harness.makeApp({ decisionOnSteps: [0], confidence: 1 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: 'pl_quick',
        })

        const blocked = await app.drive(wsId)
        const exec = blocked.find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('blocked')
        const step = exec.steps[0]!
        expect(step.state).toBe('waiting_decision')
        expect(step.decision).toBeTruthy()

        const choice = step.decision!.options[0]!
        const resolve = await app.call(
          'POST',
          `/workspaces/${wsId}/executions/${exec.id}/decisions/${step.decision!.id}`,
          { choice },
        )
        expect(resolve.status).toBe(200)

        const resumed = await app.drive(wsId)
        const finished = resumed.find((e) => e.blockId === 'task_login')!
        expect(finished.status).toBe('done')
        expect(finished.steps[0]!.decision!.chosen).toBe(choice)
      })

      it('pauses at an approval gate, then advances on approve', async () => {
        const app = harness.makeApp({ confidence: 1 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const gated = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Gated',
          agentKinds: ['architect', 'coder'],
          gates: [true, false],
        })

        await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: gated.body.id,
        })

        const blocked = await app.drive(wsId)
        const exec = blocked.find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('blocked')
        const step = exec.steps[0]!
        expect(step.state).toBe('waiting_decision')
        expect(step.approval?.status).toBe('pending')
        expect(step.approval?.proposal).toBe(step.output)
        expect(exec.steps[1]!.state).toBe('pending')
      })

      // The per-run gate-override seam (the initiative-preset gate-override, slice 2): a run
      // started with a `gates` override runs with THAT approval-gate config instead of the
      // pipeline's own, and the override is persisted on the run's steps (so it round-trips
      // through each store and survives to the driver). Exercised through the `startExecution`
      // probe (no HTTP route carries a gate override) so both stores are asserted identically.
      describe('per-run gate overrides (initiative-preset seam)', () => {
        it('an override turns a pipeline gate ON, pausing a step the pipeline left ungated', async () => {
          const app = harness.makeApp({ confidence: 1 })
          const { workspace } = await app.createWorkspace()
          const wsId = workspace.id

          // The pipeline itself declares NO gates; the per-run override enables the first one.
          const ungated = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
            name: 'Override on',
            agentKinds: ['architect', 'coder'],
            gates: [false, false],
          })
          await app.startExecution(wsId, 'task_login', ungated.body.id, { gates: [true, false] })

          const blocked = await app.drive(wsId)
          const exec = blocked.find((e) => e.blockId === 'task_login')!
          expect(exec.status).toBe('blocked')
          expect(exec.steps[0]!.state).toBe('waiting_decision')
          expect(exec.steps[0]!.approval?.status).toBe('pending')
          expect(exec.steps[1]!.state).toBe('pending')

          // The override is persisted on the run's steps, not just held in memory — read it back
          // from the runtime's real store to prove each store round-trips `requiresApproval`.
          const stored = await app.executionRepository().get(wsId, exec.id)
          expect(stored!.steps[0]!.requiresApproval).toBe(true)
          expect(stored!.steps[1]!.requiresApproval).toBe(false)
        })

        it('an override turns a pipeline gate OFF, advancing past a step the pipeline gated', async () => {
          const app = harness.makeApp({ confidence: 1 })
          const { workspace } = await app.createWorkspace()
          const wsId = workspace.id

          // The pipeline gates the first step; the per-run override disables it so the run flows
          // straight through (no human approval) — the docs-refresh "human review off" default.
          const gated = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
            name: 'Override off',
            agentKinds: ['architect', 'coder'],
            gates: [true, false],
          })
          await app.startExecution(wsId, 'task_login', gated.body.id, { gates: [false, false] })

          const settled = await app.drive(wsId)
          const exec = settled.find((e) => e.blockId === 'task_login')!
          // The first step completed without ever pausing for approval.
          expect(exec.steps[0]!.state).toBe('done')
          expect(exec.steps[0]!.approval ?? null).toBeNull()
          const stored = await app.executionRepository().get(wsId, exec.id)
          expect(stored!.steps[0]!.requiresApproval).toBe(false)
        })

        it('rejects a gate override whose length does not match the pipeline step count', async () => {
          const app = harness.makeApp({ confidence: 1 })
          const { workspace } = await app.createWorkspace()
          const wsId = workspace.id
          const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
            name: 'Mismatch',
            agentKinds: ['architect', 'coder'],
            gates: [false, false],
          })

          // A one-entry override against a two-step pipeline is rejected before any side effect.
          await expect(
            app.startExecution(wsId, 'task_login', pipeline.body.id, { gates: [true] }),
          ).rejects.toThrow(/2 step/)
        })
      })

      it('re-runs a gated step with freeform feedback and per-block comments', async () => {
        const app = harness.makeApp({ confidence: 1 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const gated = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Gated',
          agentKinds: ['architect', 'coder'],
          gates: [true, false],
        })
        await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: gated.body.id,
        })

        const blocked = await app.drive(wsId)
        const exec = blocked.find((e) => e.blockId === 'task_login')!
        const approvalId = exec.steps[0]!.approval!.id

        const res = await app.call(
          'POST',
          `/workspaces/${wsId}/executions/${exec.id}/steps/${approvalId}/request-changes`,
          {
            feedback: 'tighten the plan',
            comments: [
              { quotedSource: '## Summary', srcStart: 0, srcEnd: 1, body: 'be specific here' },
            ],
          },
        )
        expect(res.status).toBe(200)

        // The re-run folds the feedback + comment into the agent context; the fake
        // executor echoes both so we can assert they reached the agent.
        const reran = await app.drive(wsId)
        const after = reran.find((e) => e.blockId === 'task_login')!
        expect(after.steps[0]!.output).toContain('revised: tighten the plan')
        expect(after.steps[0]!.output).toContain('+1 comments')
        expect(after.steps[0]!.approval?.status).toBe('pending')
      })

      it('rejects a gated proposal, failing the run and blocking the task', async () => {
        const app = harness.makeApp({ confidence: 1 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const gated = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Gated',
          agentKinds: ['architect', 'coder'],
          gates: [true, false],
        })
        await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: gated.body.id,
        })

        const blocked = await app.drive(wsId)
        const exec = blocked.find((e) => e.blockId === 'task_login')!
        const approvalId = exec.steps[0]!.approval!.id

        const res = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/executions/${exec.id}/steps/${approvalId}/reject`,
          { reason: 'wrong direction' },
        )
        expect(res.status).toBe(200)
        expect(res.body.status).toBe('failed')
        expect(res.body.failure?.kind).toBe('rejected')
        expect(res.body.steps[0]!.approval?.status).toBe('rejected')

        const task = (
          await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        ).body.blocks.find((b) => b.id === 'task_login')!
        expect(task.status).toBe('blocked')
      })

      it('refuses to approve a rejected gate — a stale approve cannot resurrect a failed run', async () => {
        // The reject/approve race regression: approve used to read once and blind-write,
        // so an approve landing after a reject advanced the already-failed run back to
        // life. It now re-validates under optimistic concurrency and must conflict.
        const app = harness.makeApp({ confidence: 1 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const gated = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Gated',
          agentKinds: ['architect', 'coder'],
          gates: [true, false],
        })
        await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: gated.body.id,
        })

        const blocked = await app.drive(wsId)
        const exec = blocked.find((e) => e.blockId === 'task_login')!
        const approvalId = exec.steps[0]!.approval!.id

        const rejected = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/executions/${exec.id}/steps/${approvalId}/reject`,
          { reason: 'wrong direction' },
        )
        expect(rejected.status).toBe(200)
        expect(rejected.body.status).toBe('failed')

        const approve = await app.call(
          'POST',
          `/workspaces/${wsId}/executions/${exec.id}/steps/${approvalId}/approve`,
          {},
        )
        expect(approve.status).toBe(409)

        // The run stays failed and the task stays blocked — nothing was resurrected.
        const snapshot = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
        const run = snapshot.executions.find((e) => e.id === exec.id)!
        expect(run.status).toBe('failed')
        expect(run.steps[0]!.approval?.status).toBe('rejected')
        const task = snapshot.blocks.find((b) => b.id === 'task_login')!
        expect(task.status).toBe('blocked')
      })
    })

    // The Ralph loop: a persistent retry-until-done coding step whose exit condition is a
    // harness-run validation command. These assert the loop drives to completion, exhausts its
    // budget, and refuses to start unconfigured — identically on D1 and Postgres, and (because
    // the loop state rides the persisted `step.ralph`) resumable across the durable driver.
    describe('ralph loop', () => {
      const ralphPr = {
        url: 'https://github.com/o/r/pull/7',
        number: 7,
        branch: 'cat-factory/ralph',
      }

      it('loops a ralph step until its validation command passes, then advances', async () => {
        // The fake reports a failing validation for iterations 1–2 and a pass on iteration 3
        // (based on the iteration number the engine folds in), so the engine must re-dispatch
        // twice before finishing — proving the retry loop and the persisted iteration count.
        const app = harness.makeApp({
          asyncKinds: ['ralph'],
          ralphPassOnIteration: 3,
          pullRequest: ralphPr,
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const task = await app.call<Block>(
          'POST',
          `/workspaces/${wsId}/blocks/mod_sessions/tasks`,
          {
            title: 'Ralph task',
            taskType: 'ralph',
            agentConfig: {
              'ralph.validationCommand': 'echo build && echo test',
              'ralph.maxIterations': '6',
            },
          },
        )
        expect(task.status).toBe(201)
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Ralph only',
          agentKinds: ['ralph'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/${task.body.id}/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)

        const done = (await app.drive(wsId)).find((e) => e.blockId === task.body.id)!
        const step = done.steps.find((s) => s.agentKind === 'ralph')!
        expect(step.state).toBe('done')
        // Looped exactly three iterations: fail, fail, pass.
        expect(step.ralph?.attempts).toBe(3)
        expect(step.ralph?.attemptLog).toHaveLength(3)
        expect(step.ralph?.attemptLog?.[0]?.validationPassed).toBe(false)
        expect(step.ralph?.attemptLog?.at(-1)?.validationPassed).toBe(true)
        expect(step.ralph?.lastExitCode).toBe(0)
      })

      it('gives up a ralph loop that never passes, at its iteration budget', async () => {
        // The validation never passes (target far above the budget), so the loop must exhaust
        // its 2-iteration budget and fail the run for a human rather than spinning forever.
        const app = harness.makeApp({
          asyncKinds: ['ralph'],
          ralphPassOnIteration: 99,
          pullRequest: ralphPr,
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const task = await app.call<Block>(
          'POST',
          `/workspaces/${wsId}/blocks/mod_sessions/tasks`,
          {
            title: 'Ralph never-passes',
            taskType: 'ralph',
            agentConfig: {
              'ralph.validationCommand': 'exit 1',
              'ralph.maxIterations': '2',
            },
          },
        )
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Ralph only',
          agentKinds: ['ralph'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/${task.body.id}/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)

        const failed = (await app.drive(wsId)).find((e) => e.blockId === task.body.id)!
        const step = failed.steps.find((s) => s.agentKind === 'ralph')!
        expect(failed.status).toBe('failed')
        expect(step.state).not.toBe('done')
        // Ran exactly the budgeted number of iterations, no more.
        expect(step.ralph?.attempts).toBe(2)
        // The block is left blocked for a human (never falsely done).
        const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
        expect(snap.blocks.find((b) => b.id === task.body.id)?.status).toBe('blocked')
      })

      it('refuses to start a ralph pipeline with no validation command', async () => {
        // A ralph loop is meaningless without a programmatic completion criterion — the engine
        // rejects the start rather than dispatching a validation-less coding pass.
        const app = harness.makeApp({ asyncKinds: ['ralph'] })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const task = await app.call<Block>(
          'POST',
          `/workspaces/${wsId}/blocks/mod_sessions/tasks`,
          { title: 'Ralph unconfigured', taskType: 'ralph' },
        )
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Ralph only',
          agentKinds: ['ralph'],
        })
        const start = await app.call(
          'POST',
          `/workspaces/${wsId}/blocks/${task.body.id}/executions`,
          { pipelineId: pipeline.body.id },
        )
        // A validation error (missing completion criterion) — refused, run never started.
        expect(start.status).toBe(422)
      })
    })
  })
}
