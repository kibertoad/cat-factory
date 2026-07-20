import {
  type Block,
  type EnvironmentProvider,
  type ExecutionInstance,
  type Pipeline,
  type WorkspaceSnapshot,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { FakeTesterQualityReviewer } from '../FakeTesterQualityReviewer.js'
import type { ConformanceHarness } from '../harness.js'
import { STORAGE_OFF, STORAGE_ON } from './shared.js'

// Execution-engine conformance, slice 1: the pipeline-to-merge happy path plus the tester,
// fixer-loop, quality-control-companion, and visual-confirmation gate flows. Split out of the
// former monolithic `execution.ts` so no single suite file grows unbounded; the `describe`
// tree is unchanged (this re-opens the same `execution engine` group inside the one per-facade
// `[name] conformance` wrapper the aggregator provides).
export function defineExecutionTesterConformance(harness: ConformanceHarness): void {
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
          feedback: 'Only the happy path was checked; two claimed areas have no recorded outcome.',
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
        const patched = await app.call<Block>('PATCH', `/workspaces/${wsId}/blocks/blk_frontend`, {
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
        })
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
        const started = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: deployPipeline.body.id,
        })
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
  })
}
