import {
  type Block,
  type ExecutionInstance,
  type MergeThresholdPreset,
  type ModelPreset,
  type SandboxExperiment,
  type SandboxFixture,
  type SandboxPromptVersion,
  type Pipeline,
  type PipelineSchedule,
  type RequirementReview,
  type ScheduleRun,
  seedPipelines,
  type SourceTask,
  type TaskSourceDiagnostic,
  type TaskSourceState,
  type SlackMemberMappingEntry,
  type SlackNotificationSettings,
  type TrackerSettings,
  type Workspace,
  type WorkspaceSnapshot,
} from '@cat-factory/kernel'
import {
  clearRegisteredPromptFragments,
  registerPromptFragment,
} from '@cat-factory/prompt-fragments'
import { clearRegisteredAgentKinds, registerAgentKind } from '@cat-factory/agents'
// The built-in gate suite lives in its own package and registers via the public seam (the
// dogfood). The suite imports it so the runtime-neutral assertions run with the SAME gates a
// real deployment ships, and so a test that clears the registry can restore them.
import { clearGateProviders, registerBuiltinGates } from '@cat-factory/gates'
import type {
  CiStatusProvider,
  GateProbe,
  PullRequestReviewProvider,
  PullRequestReviewSnapshot,
  RepoFiles,
} from '@cat-factory/kernel'
import {
  clearRegisteredGates,
  clearRegisteredStepResolvers,
  registerGate,
  registerStepResolver,
} from '@cat-factory/kernel'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConformanceHarness } from './harness.js'

// The cross-runtime conformance suite: the KEY backend behaviour every deployment
// facade must implement identically. It is parameterised by a `ConformanceHarness`,
// so the exact same assertions run against the Cloudflare Worker (over D1, inside
// workerd) and the Node service (over real Postgres). Any behavioural drift between
// runtimes — a repository that maps a column differently, an engine path that only
// one facade wires — fails here instead of shipping silently.
//
// It deliberately covers the runtime-neutral core only (workspaces, board, the
// execution engine driven through the deterministic FakeAgentExecutor). Facade- or
// integration-specific behaviour (GitHub, documents, durable runners, real-time
// upgrade) stays in each runtime's own suite.

// The suite is split into contiguous GROUP functions (core / agents / integration /
// execution / misc) so the Postgres-backed runtimes can run each group as its own spec
// file in parallel (vitest parallelises across files, not within one). `defineConformanceSuite`
// below re-composes them into the single aggregate the Worker runs. Each group emits its
// describes directly; when called standalone they are top-level, when called from the
// aggregate they nest under one `[name] conformance` block. They share this module's
// imports and hold no cross-group state (every register/clear is scoped to its own describe).
export function defineCoreConformance(harness: ConformanceHarness): void {
  describe(`[${harness.name}] conformance`, () => {
    describe('workspaces', () => {
      it('creates a seeded board and returns a full snapshot', async () => {
        const { call } = harness.makeApp()
        const res = await call<WorkspaceSnapshot>('POST', '/workspaces', { name: 'My board' })

        expect(res.status).toBe(201)
        expect(res.body.workspace.name).toBe('My board')
        expect(res.body.blocks.find((b) => b.id === 'blk_auth')).toBeTruthy()
        // Every facade seeds a new board with the full built-in pipeline catalog.
        expect(res.body.pipelines).toEqual(seedPipelines())
        expect(res.body.executions).toHaveLength(0)
      })

      it('persists and updates a board name + description identically on every store', async () => {
        const { call } = harness.makeApp()
        const created = await call<WorkspaceSnapshot>('POST', '/workspaces', {
          name: 'Described',
          description: 'A board with a description',
          seed: false,
        })
        expect(created.body.workspace.description).toBe('A board with a description')

        // Round-trips through the store on a fresh snapshot read.
        const wsId = created.body.workspace.id
        const reread = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        expect(reread.body.workspace.description).toBe('A board with a description')

        // PATCH updates the description; null clears it.
        const updated = await call<Workspace>('PATCH', `/workspaces/${wsId}`, {
          description: 'Updated description',
        })
        expect(updated.body.description).toBe('Updated description')
        const cleared = await call<Workspace>('PATCH', `/workspaces/${wsId}`, { description: null })
        expect(cleared.body.description).toBeNull()
      })

      it('creates a board with no sample blocks when seed=false (pipelines always seeded)', async () => {
        const { call } = harness.makeApp()
        const res = await call<WorkspaceSnapshot>('POST', '/workspaces', { seed: false })

        expect(res.body.blocks).toHaveLength(0)
        // The pipeline catalog is product config, not sample data — seeded regardless
        // of the sample-block flag.
        expect(res.body.pipelines).toEqual(seedPipelines())
      })

      it('lists and deletes boards', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()

        const list = await call<Workspace[]>('GET', '/workspaces')
        expect(list.body.map((w) => w.id)).toContain(workspace.id)

        const del = await call('DELETE', `/workspaces/${workspace.id}`)
        expect(del.status).toBe(204)

        const after = await call('GET', `/workspaces/${workspace.id}`)
        expect(after.status).toBe(404)
      })

      it('returns 404 for an unknown board', async () => {
        const { call } = harness.makeApp()
        const res = await call<{ error: { code: string } }>('GET', '/workspaces/missing')

        expect(res.status).toBe(404)
        expect(res.body.error.code).toBe('not_found')
      })

      it('isolates blocks between boards', async () => {
        const { createWorkspace } = harness.makeApp()
        const a = await createWorkspace()
        const b = await createWorkspace()

        expect(a.workspace.id).not.toBe(b.workspace.id)
        expect(a.blocks.find((x) => x.id === 'blk_auth')).toBeTruthy()
        expect(b.blocks.find((x) => x.id === 'blk_auth')).toBeTruthy()
      })
    })

    describe('service spec read', () => {
      it('serves an empty service-spec view when GitHub is not wired', async () => {
        // The "View Requirements" window reads the sharded `spec/` artifact off the repo
        // default branch via the shared controller, resolved through the same
        // `resolveRunRepoContext` seam on both facades. With no GitHub wired (the
        // conformance harness), the route must be mounted and return an empty (present:false)
        // view identically — proving the symmetric wiring rather than one facade 404-ing.
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const res = await call<{ present: boolean; spec: unknown; features: unknown[] }>(
          'GET',
          `/workspaces/${workspace.id}/blocks/blk_auth/spec`,
        )
        expect(res.status).toBe(200)
        expect(res.body.present).toBe(false)
        expect(res.body.spec).toBeNull()
        expect(res.body.features).toEqual([])
      })
    })

    describe('task types + per-service running-task limit', () => {
      it('persists a task type + per-type fields, surfaced on the snapshot identically', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const wsId = workspace.id

        const created = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
          title: 'Investigate flaky login',
          taskType: 'bug',
          taskTypeFields: { severity: 'high', stepsToReproduce: 'log in repeatedly' },
        })
        expect(created.status).toBe(201)
        expect(created.body.taskType).toBe('bug')

        // The type + its per-type fields round-trip through the store identically (D1 ⇄ Postgres).
        const snapshot = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        const block = snapshot.body.blocks.find((b) => b.id === created.body.id)!
        expect(block.taskType).toBe('bug')
        expect(block.taskTypeFields?.severity).toBe('high')
      })

      it('enforces a per-service running-task limit and lifts it when the mode is off', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const wsId = workspace.id

        const pipeline = await call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Code only',
          agentKinds: ['coder'],
        })
        // Cap the auth service at one concurrently-running task.
        const settings = await call('PUT', `/workspaces/${wsId}/settings`, {
          taskLimitMode: 'shared',
          taskLimitShared: 1,
        })
        expect(settings.status).toBe(200)

        // A second task under the same service frame (blk_auth owns task_login).
        const second = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
          title: 'Second task',
        })
        expect(second.status).toBe(201)

        // First run starts and stays running (the suite's no-op runner never drives it).
        const first = await call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(first.status).toBe(201)

        // The service is now at its cap: a second start is refused with a 409 conflict.
        const blocked = await call(
          'POST',
          `/workspaces/${wsId}/blocks/${second.body.id}/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(blocked.status).toBe(409)

        // Turning the limit off lets the second task start.
        await call('PUT', `/workspaces/${wsId}/settings`, { taskLimitMode: 'off' })
        const allowed = await call(
          'POST',
          `/workspaces/${wsId}/blocks/${second.body.id}/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(allowed.status).toBe(201)
      })
    })

    describe('per-workspace budget + incident-enrichment secrets', () => {
      it('resolves a per-workspace budget set in settings, reflected in /spend (D1 ⇄ Postgres)', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const wsId = workspace.id

        // No override ⇒ the built-in deployment default budget.
        const before = await call<{ costLimit: number; currency: string }>(
          'GET',
          `/workspaces/${wsId}/spend`,
        )
        expect(before.status).toBe(200)
        expect(before.body.costLimit).toBe(100)
        expect(before.body.currency).toBe('EUR')

        // Setting a per-workspace budget must take effect immediately (the spend service's
        // pricing cache is invalidated on the settings write) and round-trip through the
        // new workspace_settings columns identically on both stores.
        const put = await call('PUT', `/workspaces/${wsId}/settings`, {
          spendMonthlyLimit: 250,
          spendCurrency: 'USD',
        })
        expect(put.status).toBe(200)

        const after = await call<{ costLimit: number; currency: string }>(
          'GET',
          `/workspaces/${wsId}/spend`,
        )
        expect(after.body.costLimit).toBe(250)
        expect(after.body.currency).toBe('USD')
      })

      it('round-trips incident-enrichment credentials, redacted + sealed (D1 ⇄ Postgres)', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const wsId = workspace.id

        type View = {
          connected: boolean
          summary: { pagerDuty: boolean; incidentIo: boolean } | null
        }
        const initial = await call<View>('GET', `/workspaces/${wsId}/incident-enrichment`)
        // Wired only when the facade has the shared encryption key; skip otherwise.
        if (initial.status === 503) return
        expect(initial.status).toBe(200)
        expect(initial.body).toMatchObject({ connected: false, summary: null })

        const put = await call<View>('PUT', `/workspaces/${wsId}/incident-enrichment`, {
          pagerDuty: { apiToken: 'pd-secret-token', fromEmail: 'oncall@example.com' },
        })
        expect(put.status).toBe(200)
        expect(put.body.summary).toEqual({ pagerDuty: true, incidentIo: false })
        // The sealed token is NEVER surfaced on any read path.
        expect(JSON.stringify(put.body)).not.toContain('pd-secret-token')

        const view = await call<View>('GET', `/workspaces/${wsId}/incident-enrichment`)
        expect(view.body).toMatchObject({
          connected: true,
          summary: { pagerDuty: true, incidentIo: false },
        })
        expect(JSON.stringify(view.body)).not.toContain('pd-secret-token')

        const del = await call('DELETE', `/workspaces/${wsId}/incident-enrichment`)
        expect(del.status).toBe(204)
        const gone = await call<View>('GET', `/workspaces/${wsId}/incident-enrichment`)
        expect(gone.body).toMatchObject({ connected: false, summary: null })
      })
    })

    describe('epics + dependency graph', () => {
      it('round-trips an epic node + a task’s epic membership identically on every store', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const wsId = workspace.id

        const epic = await call<Block>('POST', `/workspaces/${wsId}/epics`, {
          title: 'Checkout revamp',
          position: { x: 10, y: 20 },
        })
        expect(epic.status).toBe(201)
        expect(epic.body.level).toBe('epic')

        const task = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
          title: 'Part of the epic',
        })
        const assigned = await call<Block>(
          'POST',
          `/workspaces/${wsId}/blocks/${task.body.id}/epic`,
          { epicId: epic.body.id },
        )
        expect(assigned.status).toBe(200)
        expect(assigned.body.epicId).toBe(epic.body.id)

        // Both the epic level and the membership link survive the store round-trip.
        const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        expect(snap.body.blocks.find((b) => b.id === epic.body.id)?.level).toBe('epic')
        expect(snap.body.blocks.find((b) => b.id === task.body.id)?.epicId).toBe(epic.body.id)
      })

      it('rejects a dependency edge that would create a cycle', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const wsId = workspace.id
        const a = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
          title: 'A',
        })
        const b = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
          title: 'B',
        })
        // A dependsOn B — fine.
        const first = await call('POST', `/workspaces/${wsId}/blocks/${a.body.id}/dependencies`, {
          sourceId: b.body.id,
        })
        expect(first.status).toBe(200)
        // B dependsOn A — would close a cycle, rejected (ValidationError → 422).
        const cyclic = await call('POST', `/workspaces/${wsId}/blocks/${b.body.id}/dependencies`, {
          sourceId: a.body.id,
        })
        expect(cyclic.status).toBe(422)
      })

      it('refuses to start a task while a dependency is unfinished', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const wsId = workspace.id
        const pipeline = await call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Code only',
          agentKinds: ['coder'],
        })
        const blocker = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
          title: 'Blocker',
        })
        // task_login dependsOn the (planned) blocker.
        await call('POST', `/workspaces/${wsId}/blocks/task_login/dependencies`, {
          sourceId: blocker.body.id,
        })
        const blocked = await call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(blocked.status).toBe(409)
      })
    })

    describe('model presets', () => {
      it('seeds the built-ins, CRUDs presets and surfaces them on the snapshot', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()

        // A fresh workspace is lazily seeded with the built-in presets: Kimi K2.7
        // (the default, everything Kimi) and GLM-5.2.
        const initial = await call<ModelPreset[]>(
          'GET',
          `/workspaces/${workspace.id}/model-presets`,
        )
        expect(initial.status).toBe(200)
        const seeded = initial.body
        expect(seeded.length).toBeGreaterThanOrEqual(2)
        const def = seeded.find((p) => p.isDefault)
        expect(def?.baseModelId).toBe('kimi-k2.7')
        expect(seeded.some((p) => p.baseModelId === 'glm')).toBe(true)

        // Create a new preset with a per-agent override and promote it to default.
        const created = await call<ModelPreset>(
          'POST',
          `/workspaces/${workspace.id}/model-presets`,
          {
            name: 'Mixed',
            baseModelId: 'glm',
            overrides: { architect: 'kimi-k2.7' },
            isDefault: true,
          },
        )
        expect(created.status).toBe(201)
        expect(created.body.isDefault).toBe(true)
        expect(created.body.overrides.architect).toBe('kimi-k2.7')

        // Promoting it demoted the previous default (single-default invariant).
        const afterCreate = await call<ModelPreset[]>(
          'GET',
          `/workspaces/${workspace.id}/model-presets`,
        )
        expect(afterCreate.body.filter((p) => p.isDefault)).toHaveLength(1)
        expect(afterCreate.body.find((p) => p.isDefault)?.id).toBe(created.body.id)

        // Patch the base model.
        const patched = await call<ModelPreset>(
          'PATCH',
          `/workspaces/${workspace.id}/model-presets/${created.body.id}`,
          { baseModelId: 'kimi-k2.7' },
        )
        expect(patched.status).toBe(200)
        expect(patched.body.baseModelId).toBe('kimi-k2.7')

        // The library rides along on the workspace snapshot.
        const snapshot = await call<WorkspaceSnapshot>('GET', `/workspaces/${workspace.id}`)
        expect((snapshot.body.modelPresets ?? []).some((p) => p.name === 'Mixed')).toBe(true)
      })
    })
  })
}

export function defineAgentConformance(harness: ConformanceHarness): void {
  describe(`[${harness.name}] conformance`, () => {
    describe('sandbox (prompt/model testing surface)', () => {
      it('lists baselines, clones+versions prompts, seeds fixtures and defines experiments', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/sandbox`

        // Overview seeds the builtin fixtures on first load and exposes the testable
        // agent-kind catalog + the shipped baselines (synthetic, never persisted).
        const overview = await call<{
          agentKinds: { agentKind: string }[]
          prompts: SandboxPromptVersion[]
          fixtures: SandboxFixture[]
          experiments: SandboxExperiment[]
          maxCells: number
        }>('GET', `${base}/overview`)
        expect(overview.status).toBe(200)
        expect(overview.body.agentKinds.some((k) => k.agentKind === 'requirements-review')).toBe(
          true,
        )
        expect(overview.body.prompts.some((p) => p.origin === 'baseline')).toBe(true)
        expect(overview.body.fixtures.length).toBeGreaterThan(0)
        // The cell cap is surfaced so the UI gates on the SAME limit instead of re-encoding it.
        expect(overview.body.maxCells).toBeGreaterThan(0)
        const fixture = overview.body.fixtures.find((f) => f.kind === 'requirements')!
        expect(fixture).toBeTruthy()

        // Clone the requirements-review baseline into an editable candidate lineage (v1).
        const cloned = await call<SandboxPromptVersion>('POST', `${base}/prompts/clone`, {
          agentKind: 'requirements-review',
          basePromptId: 'requirement-review',
          name: 'My reviewer',
        })
        expect(cloned.status).toBe(201)
        expect(cloned.body.origin).toBe('candidate')
        expect(cloned.body.version).toBe(1)
        expect(cloned.body.systemText.length).toBeGreaterThan(0)

        // Append an edited version onto the lineage (v2 on the same lineage id).
        const v2 = await call<SandboxPromptVersion>('POST', `${base}/prompts`, {
          parentId: cloned.body.id,
          systemText: `${cloned.body.systemText}\n\nAlways check authz.`,
        })
        expect(v2.status).toBe(201)
        expect(v2.body.version).toBe(2)
        expect(v2.body.lineageId).toBe(cloned.body.lineageId)

        // Both candidate versions + the baselines come back from the prompt listing.
        const prompts = await call<SandboxPromptVersion[]>('GET', `${base}/prompts`)
        expect(prompts.body.filter((p) => p.lineageId === cloned.body.lineageId)).toHaveLength(2)

        // Define a draft experiment over the baseline prompt × one model × the fixture.
        const experiment = await call<SandboxExperiment>('POST', `${base}/experiments`, {
          name: 'Reviewer shootout',
          agentKind: 'requirements-review',
          judgeModel: 'anthropic:claude-opus-4-8',
          matrix: {
            promptVersionIds: ['baseline:requirement-review'],
            models: ['anthropic:claude-opus-4-8'],
            fixtureIds: [fixture.id],
          },
        })
        expect(experiment.status).toBe(201)
        expect(experiment.body.status).toBe('draft')
        expect(experiment.body.judgeModel.length).toBeGreaterThan(0)

        // The experiment + its (still empty) result grid read back.
        const detail = await call<{
          experiment: SandboxExperiment
          runs: unknown[]
          grades: unknown[]
        }>('GET', `${base}/experiments/${experiment.body.id}`)
        expect(detail.status).toBe(200)
        expect(detail.body.experiment.id).toBe(experiment.body.id)
        expect(detail.body.runs).toHaveLength(0)
        expect(detail.body.grades).toHaveLength(0)

        // A non-runnable matrix is rejected at create time.
        const empty = await call('POST', `${base}/experiments`, {
          name: 'Bad',
          agentKind: 'requirements-review',
          matrix: { promptVersionIds: [], models: [], fixtureIds: [] },
        })
        expect(empty.status).toBeGreaterThanOrEqual(400)

        // A zero token budget is rejected at create (it would otherwise fail every cell).
        const zeroBudget = await call('POST', `${base}/experiments`, {
          name: 'No budget',
          agentKind: 'requirements-review',
          judgeModel: 'anthropic:claude-opus-4-8',
          matrix: {
            promptVersionIds: ['baseline:requirement-review'],
            models: ['anthropic:claude-opus-4-8'],
            fixtureIds: [fixture.id],
          },
          budgetTokens: 0,
        })
        expect(zeroBudget.status).toBeGreaterThanOrEqual(400)
      })

      it('drives the run/grade lifecycle to a terminal grid identically across runtimes', async () => {
        // Force the model provider ON for both runtimes (the Worker binds `AI`, Node has no
        // binding) so `launch` reaches the run-driver identically rather than 503/400-ing at
        // provider resolution on one facade only.
        const { call, createWorkspace } = harness.makeApp(undefined, {
          cloudflareModelsEnabled: true,
        })
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/sandbox`

        const overview = await call<{ fixtures: SandboxFixture[] }>('GET', `${base}/overview`)
        const fixture = overview.body.fixtures.find((f) => f.kind === 'requirements')!

        // Define a 2-cell experiment against a deliberately UNCONFIGURED provider: the
        // run-driver resolves the model per cell and the resolve throws (no key wired in
        // the suite), so every candidate fails WITHOUT any network call. This exercises the
        // whole driver path — expand→persist→run→settle, plus the relaunch delete ordering
        // (grades before runs) — identically on D1 and Postgres, which the CRUD-only block
        // above never reached. A graded happy path needs a fake judge model and is a
        // tracked follow-up.
        const created = await call<SandboxExperiment>('POST', `${base}/experiments`, {
          name: 'Driver parity',
          agentKind: 'requirements-review',
          judgeModel: 'no-such-vendor:none',
          matrix: {
            promptVersionIds: ['baseline:requirement-review'],
            models: ['no-such-vendor:a', 'no-such-vendor:b'],
            fixtureIds: [fixture.id],
          },
        })
        expect(created.status).toBe(201)

        const launched = await call<{
          experiment: SandboxExperiment
          runs: { status: string; error?: string }[]
          grades: unknown[]
        }>('POST', `${base}/experiments/${created.body.id}/launch`)
        expect(launched.status).toBe(200)
        // Every candidate failed → no cell graded → the experiment settles `failed`, never
        // a misleading `done` with an unscored grid, and never stuck `running`.
        expect(launched.body.experiment.status).toBe('failed')
        expect(launched.body.runs).toHaveLength(2)
        expect(launched.body.runs.every((r) => r.status === 'failed')).toBe(true)
        expect(launched.body.grades).toHaveLength(0)

        // A relaunch replaces the grid in place rather than accumulating cells.
        const relaunched = await call<{ runs: unknown[] }>(
          'POST',
          `${base}/experiments/${created.body.id}/launch`,
        )
        expect(relaunched.status).toBe(200)
        expect(relaunched.body.runs).toHaveLength(2)

        // Two CONCURRENT launches must not duplicate the grid: the experiment's atomic claim
        // (`claimForRun`) lets exactly one win the run at a time, so whichever interleaving the
        // real store produces, the grid still settles to exactly 2 cells (never 4) — and at
        // least one launch succeeds rather than both 409-ing.
        const [first, second] = await Promise.all([
          call('POST', `${base}/experiments/${created.body.id}/launch`),
          call('POST', `${base}/experiments/${created.body.id}/launch`),
        ])
        expect([first.status, second.status].some((s) => s === 200)).toBe(true)
        const afterRace = await call<{ runs: unknown[] }>(
          'GET',
          `${base}/experiments/${created.body.id}`,
        )
        expect(afterRace.body.runs).toHaveLength(2)
      })
    })

    describe('service-scoped fragments + agent traits', () => {
      it('reads, replaces and surfaces the workspace default service-fragment set', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()

        // A fresh workspace has no default service fragments.
        const initial = await call<{ fragmentIds: string[] }>(
          'GET',
          `/workspaces/${workspace.id}/service-fragment-defaults`,
        )
        expect(initial.status).toBe(200)
        expect(initial.body.fragmentIds).toEqual([])

        // Replace the whole list (ids aren't validated against the catalog here).
        const put = await call<{ fragmentIds: string[] }>(
          'PUT',
          `/workspaces/${workspace.id}/service-fragment-defaults`,
          { fragmentIds: ['node.best-practices', 'node.performance'] },
        )
        expect(put.status).toBe(200)
        expect(put.body.fragmentIds).toEqual(['node.best-practices', 'node.performance'])

        // It persisted and rides along on the snapshot.
        const snapshot = await call<WorkspaceSnapshot>('GET', `/workspaces/${workspace.id}`)
        expect(snapshot.body.serviceFragmentDefaults?.fragmentIds).toEqual([
          'node.best-practices',
          'node.performance',
        ])

        // A new service inherits the default onto its serviceFragmentIds.
        const frame = await call<Block>('POST', `/workspaces/${workspace.id}/blocks`, {
          type: 'service',
          position: { x: 5, y: 5 },
        })
        expect(frame.body.serviceFragmentIds).toEqual(['node.best-practices', 'node.performance'])
      })

      it('folds the service fragments into code-aware agents only', async () => {
        // Register a deployment-style custom fragment into the universal pool, select it
        // as a service's standards, and assert the engine folds it into a `code-aware`
        // step's prompt (coder) but not a non-code-aware one (documenter).
        registerPromptFragment({
          id: 'test.svc-standard',
          version: '1.0.0',
          title: 'Service standard',
          category: 'Test',
          summary: 'A registered service standard.',
          body: 'SERVICE-STANDARD-BODY',
        })
        try {
          const app = harness.makeApp({ echoFragments: true })
          const { workspace } = await app.createWorkspace()
          const wsId = workspace.id

          // Set the service-level selection on the seeded auth frame (task_login's owner).
          await app.call('PATCH', `/workspaces/${wsId}/blocks/blk_auth`, {
            serviceFragmentIds: ['test.svc-standard'],
          })

          const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
            name: 'Code + document',
            agentKinds: ['coder', 'documenter'],
          })
          const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
            pipelineId: pipeline.body.id,
          })
          expect(start.status).toBe(201)
          const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!

          // The coder is `code-aware`: it receives the service's fragment.
          const coder = exec.steps.find((s) => s.agentKind === 'coder')!
          expect(coder.output).toContain('[frags]test.svc-standard[/frags]')
          expect(coder.selectedFragmentIds).toEqual(['test.svc-standard'])

          // The documenter is neither code-aware nor spec-aware: no service fragments.
          const documenter = exec.steps.find((s) => s.agentKind === 'documenter')!
          expect(documenter.output).toContain('[frags][/frags]')
          expect(documenter.selectedFragmentIds ?? []).toEqual([])
        } finally {
          clearRegisteredPromptFragments()
        }
      })

      it('resolves a managed (DB-backed) workspace fragment into a code-aware run', async () => {
        // Unlike the previous test (a fragment in the in-memory static pool), this one
        // is persisted in the facade's real fragment store. It asserts the engine now
        // resolves run-time fragment ids against the merged TENANT CATALOG — so a
        // managed fragment (the foundation document-backed fragments build on) actually
        // reaches a `code-aware` agent, identically on D1 and Postgres. A fragment id
        // that failed to resolve would be dropped, so a non-empty selection is the proof.
        const app = harness.makeApp({ echoFragments: true })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const created = await app.call('POST', `/workspaces/${wsId}/prompt-fragments`, {
          id: 'db.managed-standard',
          title: 'Managed standard',
          summary: 'A DB-backed standard.',
          body: 'MANAGED-DB-BODY',
        })
        expect(created.status).toBe(201)

        await app.call('PATCH', `/workspaces/${wsId}/blocks/blk_auth`, {
          serviceFragmentIds: ['db.managed-standard'],
        })
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Code',
          agentKinds: ['coder'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!

        const coder = exec.steps.find((s) => s.agentKind === 'coder')!
        expect(coder.output).toContain('[frags]db.managed-standard[/frags]')
        expect(coder.selectedFragmentIds).toEqual(['db.managed-standard'])
      })
    })

    describe('registered custom kind pre/post-ops', () => {
      afterEach(() => clearRegisteredAgentKinds())

      // A registered custom agent kind decomposes into preOps → agent → postOps, with the
      // deterministic repo work (read a baseline artifact, render + commit files) running
      // as BACKEND TypeScript over the checkout-free RepoFiles port — never in a container.
      // This asserts the engine actually RUNS those hooks (and binds them to the run's repo)
      // identically on every runtime, so a facade that forgot to wire `resolveRunRepoContext`
      // fails here rather than silently skipping a custom kind's render.
      it('runs a kind’s pre-op + post-op, committing rendered files via the checkout-free RepoFiles', async () => {
        // An in-memory RepoFiles capturing what the hooks read + commit (the suite's stand-in
        // for a facade's GitHubClient-backed RepoFiles), so the assertion needs no real GitHub.
        const reads: string[] = []
        const commits: { branch: string; files: { path: string; content: string }[] }[] = []
        const repo: RepoFiles = {
          getFile: async (path) => {
            reads.push(path)
            return null
          },
          listDirectory: async () => [],
          headSha: async () => 'base-sha',
          createBranch: async () => {},
          commitFiles: async (input) => {
            commits.push({ branch: input.branch, files: input.files })
            return { sha: 'commit-sha' }
          },
          openPullRequest: async () => {
            throw new Error('not exercised by this test')
          },
        }

        registerAgentKind({
          kind: 'conformance-auditor',
          systemPrompt: 'You audit the service for compliance.',
          // A read-only container-explore step returning structured JSON (surfaced as
          // `result.custom`) — exactly the generic manifest-driven `agent` dispatch.
          agent: { surface: 'container-explore', output: { kind: 'structured' } },
          // PRE-op: read a baseline artifact (no checkout). Proves pre-ops run + are bound
          // to the resolved branch.
          preOps: [
            async (ctx) => {
              await ctx.repo.getFile('compliance/POLICY.md', ctx.branch)
            },
          ],
          // POST-op: render a file from the agent's structured output + commit it. The
          // backend-side rendering that used to live in the harness.
          postOps: [
            async (ctx) => {
              const custom = ctx.result?.custom as { findings?: string } | undefined
              await ctx.repo.commitFiles({
                branch: ctx.branch,
                message: 'chore: compliance report',
                files: [
                  {
                    path: 'compliance/REPORT.md',
                    content: `# Compliance report\n\n${custom?.findings ?? '(none)'}\n`,
                  },
                ],
              })
            },
          ],
        })

        const app = harness.makeApp(
          { customResult: { findings: 'all clear' } },
          { resolveRunRepoContext: async () => ({ repo, baseBranch: 'main' }) },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Compliance audit',
          agentKinds: ['conformance-auditor'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')

        // The pre-op read the baseline artifact on the resolved branch…
        expect(reads).toContain('compliance/POLICY.md')
        // …and the post-op committed the rendered file from the agent's `custom` output —
        // via the checkout-free RepoFiles port, identically on D1 and Postgres. The kind
        // declares no clone target, so it resolves to the per-block work branch
        // `cat-factory/<blockId>` the container agent would use — NOT the default branch,
        // so a committing post-op never silently lands on `main`.
        expect(commits).toHaveLength(1)
        expect(commits[0]?.branch).toBe('cat-factory/task_login')
        expect(commits[0]?.files[0]?.path).toBe('compliance/REPORT.md')
        expect(commits[0]?.files[0]?.content).toContain('all clear')
      })
    })

    describe('registered custom gate + step resolver', () => {
      afterEach(() => {
        clearRegisteredGates()
        clearRegisteredStepResolvers()
        clearRegisteredAgentKinds()
        // The built-in gates (ci / conflicts / post-release-health) live in the SAME registry
        // as the test's `license-check` gate, so clearing wipes them too — restore them so
        // later assertions (and a real harness build) still see the platform's own gates.
        registerBuiltinGates()
      })

      // A deployment-registered polling gate is the OTHER half of the extension story
      // (alongside custom agent kinds): a deterministic precheck that passes through when
      // clean and only escalates to a registered helper agent on a red verdict. The engine
      // merges it into the (otherwise built-in) gate registry and drives it through the SAME
      // generic gate machine — so a facade that forgot to wire the registry merge, or one
      // whose gate state machine drifts, fails here rather than shipping. Mirrors the
      // built-in `ci`→`ci-fixer` gate, with the provider faked in-test (no real GitHub).

      // The custom gate's helper is just a registered agent kind — no new dispatch path.
      const registerLicenseFixer = (): void =>
        registerAgentKind({
          kind: 'license-fixer',
          systemPrompt: 'You add missing license headers and push.',
          agent: { surface: 'container-coding', clone: { branch: 'pr' } },
        })

      // Register the `license-check` gate over a fake provider whose verdict is supplied
      // per-probe (a queue; the last entry repeats) so a test can drive pass / escalate.
      const registerLicenseGate = (verdicts: boolean[]): void => {
        let i = 0
        registerGate('license-check', (ctx) => ({
          kind: 'license-check',
          helperKind: 'license-fixer',
          wired: () => true,
          unwiredOutput: 'license gate skipped',
          probe: async (): Promise<GateProbe> => {
            const clean = verdicts[Math.min(i, verdicts.length - 1)] ?? true
            i += 1
            return clean
              ? { status: 'pass', headSha: 'sha', passOutput: 'license gate passed' }
              : { status: 'fail', headSha: 'sha', failureSummary: 'missing headers' }
          },
          onExhausted: async ({ workspaceId, block, instance }) => {
            await ctx.raiseNotification(workspaceId, {
              type: 'decision_required',
              blockId: block.id,
              executionId: instance.id,
              title: 'License headers still missing',
              body: 'spent',
            })
            return { error: 'license headers still missing' }
          },
        }))
      }

      it('passes through on a clean precheck without spinning up the helper', async () => {
        registerLicenseFixer()
        registerLicenseGate([true]) // clean on first probe
        const app = harness.makeApp({ asyncKinds: ['coder', 'license-fixer'] })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + license check',
          agentKinds: ['coder', 'license-check'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)

        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        const step = exec.steps.find((s) => s.agentKind === 'license-check')!
        expect(step.state).toBe('done')
        // Clean precheck ⇒ the helper was NEVER dispatched (no attempts spent).
        expect(step.gate?.attempts ?? 0).toBe(0)
        expect(step.output).toContain('license gate passed')
      })

      it('escalates to the helper on a red precheck, then advances when it re-probes clean', async () => {
        registerLicenseFixer()
        registerLicenseGate([false, true]) // red first, clean after the fixer ran
        const app = harness.makeApp({
          asyncKinds: ['coder', 'license-fixer'],
          pullRequest: { url: 'https://github.com/o/r/pull/1', number: 1, branch: 'feat/login' },
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + license check',
          agentKinds: ['coder', 'license-check'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)

        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        const step = exec.steps.find((s) => s.agentKind === 'license-check')!
        expect(step.state).toBe('done')
        // One escalation: the helper was dispatched once, then the re-probe passed.
        expect(step.gate?.attempts).toBe(1)
        expect(step.gate?.attemptLog?.[0]?.outcome).toBe('completed')
      })

      // A registered step resolver runs deterministic backend follow-up keyed on the
      // finished step's agentKind — here it rewrites a custom kind's step output. Asserts
      // the engine merges registered resolvers into the (built-in merger) resolver registry
      // and runs them in recordStepResult, identically on every runtime.
      it('runs a registered step resolver after its agent step completes', async () => {
        registerAgentKind({
          kind: 'conformance-auditor',
          systemPrompt: 'You audit.',
          agent: { surface: 'container-explore', output: { kind: 'structured' } },
        })
        registerStepResolver('conformance-auditor', () => ({
          kind: 'conformance-auditor',
          applies: (result) => result.custom !== undefined,
          resolve: async () => ({ output: 'resolver-rewrote-this' }),
        }))
        const app = harness.makeApp({ customResult: { ok: true } })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Audit',
          agentKinds: ['conformance-auditor'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)

        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        const step = exec.steps.find((s) => s.agentKind === 'conformance-auditor')!
        expect(step.output).toBe('resolver-rewrote-this')
      })
    })

    describe('built-in ci gate (externalized to @cat-factory/gates)', () => {
      // The platform's OWN `ci` gate is now authored as an external package through the public
      // `registerGate` seam — no longer inline in the engine. Driving it here over a faked
      // CiStatusProvider proves the externalized built-in still passes-through on green CI and
      // escalates to `ci-fixer` on red, identically on every runtime: if the gate package, the
      // wire-handle, or a facade's import drifted, this fails instead of shipping.
      afterEach(() => clearGateProviders())

      // A fake CI provider whose check verdict is supplied per-probe (a queue; the last entry
      // repeats), so a test can drive green / red→green like the registered-gate test does.
      // It is injected THROUGH `makeApp` (`gateProviders`), not wired directly: a facade build
      // resets the deployment-global gate providers up-front and the Worker rebuilds the
      // container per request, so a directly-wired provider would be cleared before the gate
      // probes. Threading it into the build re-wires it on every rebuild, on every runtime.
      const makeFakeCi = (greens: boolean[]): CiStatusProvider => {
        let i = 0
        return {
          getStatus: async () => {
            const green = greens[Math.min(i, greens.length - 1)] ?? true
            i += 1
            return {
              headSha: 'sha',
              checks: [
                {
                  name: 'build',
                  status: 'completed',
                  conclusion: green ? 'success' : 'failure',
                  url: null,
                },
              ],
            }
          },
        }
      }

      it('passes through on green CI without spinning up ci-fixer', async () => {
        const app = harness.makeApp(
          { asyncKinds: ['coder', 'ci-fixer'] },
          { gateProviders: { ciStatus: makeFakeCi([true]) } },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + CI',
          agentKinds: ['coder', 'ci'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)

        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        const step = exec.steps.find((s) => s.agentKind === 'ci')!
        expect(step.state).toBe('done')
        expect(step.gate?.attempts ?? 0).toBe(0)
        expect(step.output).toContain('CI gate passed')
      })

      it('escalates to ci-fixer on red CI, then advances when it re-probes green', async () => {
        const app = harness.makeApp(
          {
            asyncKinds: ['coder', 'ci-fixer'],
            pullRequest: { url: 'https://github.com/o/r/pull/1', number: 1, branch: 'feat/login' },
          },
          // red first, green after the fixer ran
          { gateProviders: { ciStatus: makeFakeCi([false, true]) } },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + CI',
          agentKinds: ['coder', 'ci'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)

        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        const step = exec.steps.find((s) => s.agentKind === 'ci')!
        expect(step.state).toBe('done')
        expect(step.gate?.attempts).toBe(1)
        expect(step.gate?.attemptLog?.[0]?.outcome).toBe('completed')
      })
    })

    describe('built-in human-review gate (externalized to @cat-factory/gates)', () => {
      // The `human-review` gate watches the PR for a human code review and loops the `fixer` to
      // address review threads, advancing once approved with no unresolved threads. Driving it
      // over a faked PullRequestReviewProvider proves the externalized gate + its wire-handle +
      // each facade's import behave identically: the gate dispatches the fixer, resolves the
      // handed thread on the helper's completion, then advances — or a drift fails here.
      afterEach(() => clearGateProviders())

      const APPROVED_CLEAN: PullRequestReviewSnapshot = {
        headSha: 'sha',
        requiredApprovingReviewCount: 1,
        assignedReviewers: [],
        approvals: 1,
        unresolvedThreads: [],
        comments: [],
      }

      it('passes through when approved with no unresolved threads', async () => {
        const app = harness.makeApp(
          { asyncKinds: ['coder', 'fixer'] },
          {
            gateProviders: {
              prReview: { getReview: async () => APPROVED_CLEAN, resolveThreads: async () => {} },
            },
          },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + review',
          agentKinds: ['coder', 'human-review'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        const step = exec.steps.find((s) => s.agentKind === 'human-review')!
        expect(step.state).toBe('done')
        expect(step.gate?.attempts ?? 0).toBe(0)
      })

      it('loops the fixer on an unresolved thread, resolves it, then advances', async () => {
        // Approved (so dispatch is immediate, no grace/clock dependence) WITH one unresolved
        // thread → dispatch the fixer; onHelperComplete resolves the thread; the re-probe then
        // sees it clean and advances.
        const resolvedThreads: string[] = []
        let resolved = false
        const provider: PullRequestReviewProvider = {
          getReview: async () =>
            resolved
              ? APPROVED_CLEAN
              : {
                  ...APPROVED_CLEAN,
                  unresolvedThreads: [
                    {
                      threadId: 'T1',
                      author: 'alice',
                      bodyExcerpt: 'rename this',
                      path: 'src/a.ts',
                      line: 1,
                      isBot: false,
                      latestCommentAt: 0,
                    },
                  ],
                },
          resolveThreads: async (_ws, _b, ids) => {
            resolvedThreads.push(...ids)
            resolved = true
          },
        }
        const app = harness.makeApp(
          {
            asyncKinds: ['coder', 'fixer'],
            pullRequest: { url: 'https://github.com/o/r/pull/1', number: 1, branch: 'feat/login' },
          },
          { gateProviders: { prReview: provider } },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + review',
          agentKinds: ['coder', 'human-review'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        const step = exec.steps.find((s) => s.agentKind === 'human-review')!
        expect(step.state).toBe('done')
        expect(step.gate?.attempts).toBe(1)
        expect(resolvedThreads).toEqual(['T1'])
      })
    })

    describe('built-in blueprints post-op', () => {
      // The migrated `blueprints` kind dispatches the generic `agent` (read-only structured
      // explore) and returns its tree; the deterministic render + commit of the in-repo
      // `blueprints/` artifact — which used to live in the executor-harness `/blueprint`
      // handler — now runs as a BACKEND built-in post-op over the checkout-free RepoFiles,
      // keyed by the engine's built-in op map (NOT the registry). This asserts the engine
      // runs that post-op + commits identically on every runtime, so a facade that forgot to
      // wire `resolveRunRepoContext` fails here rather than silently dropping the artifact.
      it('renders + commits the blueprints/ artifact via RepoFiles when GitHub is wired', async () => {
        const commits: { branch: string; files: { path: string; content: string }[] }[] = []
        const repo: RepoFiles = {
          getFile: async () => null,
          listDirectory: async () => [],
          headSha: async () => 'base-sha',
          createBranch: async () => {},
          commitFiles: async (input) => {
            commits.push({ branch: input.branch, files: input.files })
            return { sha: 'commit-sha' }
          },
          openPullRequest: async () => {
            throw new Error('not exercised by this test')
          },
        }

        const app = harness.makeApp(
          {
            blueprintService: {
              name: 'Widgets',
              summary: 'A widget service.',
              modules: [{ name: 'Billing', summary: 'Invoices', references: ['src/billing.ts'] }],
            },
          },
          { resolveRunRepoContext: async () => ({ repo, baseBranch: 'main' }) },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Map service',
          agentKinds: ['blueprints'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')

        // The post-op committed the rendered artifact (no PR open ⇒ the default branch),
        // identically on D1 and Postgres — proving the built-in post-op map is engine-side,
        // not facade-specific.
        expect(commits).toHaveLength(1)
        expect(commits[0]?.branch).toBe('main')
        const paths = commits[0]?.files.map((f) => f.path) ?? []
        expect(paths).toContain('blueprints/blueprint.json')
        expect(paths).toContain('blueprints/version.json')
        expect(paths).toContain('blueprints/modules/billing.md')
      })
    })

    describe('built-in spec-writer post-op', () => {
      // The migrated `spec-writer` kind dispatches the generic `agent` (read-only structured
      // explore) and returns the complete spec doc; the deterministic SHARD + commit of the
      // in-repo `spec/` artifact — which used to live in the executor-harness `/spec` handler —
      // now runs as a BACKEND built-in post-op over the checkout-free RepoFiles, onto the
      // per-block WORK branch (not the default branch — the spec merges WITH the feature). This
      // asserts the engine runs that post-op + commits identically on every runtime.
      it('shards + commits the spec/ artifact onto the work branch via RepoFiles', async () => {
        const commits: { branch: string; files: { path: string; content: string }[] }[] = []
        const repo: RepoFiles = {
          getFile: async () => null,
          listDirectory: async () => [],
          headSha: async () => 'base-sha',
          createBranch: async () => {},
          commitFiles: async (input) => {
            commits.push({ branch: input.branch, files: input.files })
            return { sha: 'commit-sha' }
          },
          openPullRequest: async () => {
            throw new Error('not exercised by this test')
          },
        }

        const app = harness.makeApp(
          {
            spec: {
              service: 'Widgets',
              summary: 'A widget service.',
              modules: [
                {
                  name: 'Auth',
                  summary: 'Authentication',
                  groups: [
                    {
                      name: 'Login',
                      summary: 'Signing in',
                      requirements: [
                        {
                          title: 'Password login',
                          statement: 'The system SHALL authenticate by password.',
                          kind: 'functional',
                          priority: 'must',
                          acceptance: [
                            { given: 'a user', when: 'they sign in', outcome: 'a session opens' },
                          ],
                        },
                      ],
                      rules: [],
                    },
                  ],
                },
              ],
            },
          },
          { resolveRunRepoContext: async () => ({ repo, baseBranch: 'main' }) },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Write spec',
          agentKinds: ['spec-writer'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')

        // The post-op sharded the doc onto the per-block work branch (created from base when
        // absent), identically on D1 and Postgres.
        expect(commits).toHaveLength(1)
        expect(commits[0]?.branch).toBe('cat-factory/task_login')
        const paths = commits[0]?.files.map((f) => f.path) ?? []
        expect(paths).toContain('spec/service.json')
        expect(paths).toContain('spec/overview.md')
        expect(paths).toContain('spec/modules/auth/login.json')
        expect(paths).toContain('spec/features/auth/login.feature')
      })
    })

    describe('task estimator + consensus', () => {
      it('parses a task-estimator step output onto block.estimate, persisted identically', async () => {
        const app = harness.makeApp({
          taskEstimate: { complexity: 0.7, risk: 0.8, impact: 0.6, rationale: 'fake estimate' },
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Estimate + code',
          agentKinds: ['task-estimator', 'coder'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)
        await app.drive(wsId)

        // The estimator's JSON output round-trips onto the block's `estimate` column —
        // the same shape from D1 (SQLite) and Postgres.
        const snapshot = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        const block = snapshot.body.blocks.find((b) => b.id === 'task_login')!
        expect(block.estimate).toBeTruthy()
        expect(block.estimate!.complexity).toBe(0.7)
        expect(block.estimate!.risk).toBe(0.8)
        expect(block.estimate!.impact).toBe(0.6)
        expect(block.estimate!.rationale).toContain('fake estimate')
      })

      describe('technical-label inference (spec phase)', () => {
        // Drive a spec-writer → spec-companion pipeline and assert the engine infers the
        // block's `technical` label from the writer's `noBusinessSpecs` + the companion's
        // `technicalCorroborated`, honouring human authority — identically on both runtimes.
        const runSpecPhase = async (
          opts: { noBusinessSpecs?: boolean; spec?: unknown; technicalCorroborated?: boolean },
          preset?: { technical?: boolean | null },
        ) => {
          const app = harness.makeApp(opts)
          const { workspace } = await app.createWorkspace()
          const wsId = workspace.id
          if (preset) {
            await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, preset)
          }
          const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
            name: 'Spec phase',
            agentKinds: ['spec-writer', 'spec-companion'],
          })
          const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
            pipelineId: pipeline.body.id,
          })
          expect(start.status).toBe(201)
          await app.drive(wsId)
          const snapshot = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
          return snapshot.body.blocks.find((b) => b.id === 'task_login')!
        }

        it('infers technical=true when the writer produced no business specs and the companion corroborates', async () => {
          const block = await runSpecPhase({ noBusinessSpecs: true, technicalCorroborated: true })
          expect(block.technical).toBe(true)
        })

        it('infers the symmetric business case (false) when specs were produced', async () => {
          const block = await runSpecPhase({
            spec: { service: 'Auth', summary: '', modules: [] },
            technicalCorroborated: false,
          })
          expect(block.technical).toBe(false)
        })

        it('leaves the label undetermined when the companion gives no opinion', async () => {
          const block = await runSpecPhase({ noBusinessSpecs: true })
          expect(block.technical == null).toBe(true)
        })

        it('never overrides a human-set label', async () => {
          // The human marked it BUSINESS up front; the spec phase would infer TECHNICAL,
          // but human authority wins and the stored value is left untouched.
          const block = await runSpecPhase(
            { noBusinessSpecs: true, technicalCorroborated: true },
            { technical: false },
          )
          expect(block.technical).toBe(false)
        })
      })

      it('persists a consensus config on a pipeline step, surfaced on the snapshot', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const created = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Consensus architect',
          agentKinds: ['architect', 'coder'],
          consensus: [
            {
              enabled: true,
              strategy: 'debate',
              rounds: 2,
              participants: [
                { id: 'cp1', role: 'Pragmatist' },
                { id: 'cp2', role: 'Skeptic' },
              ],
              gating: { enabled: true, minRisk: 0.6 },
            },
            null,
          ],
        })
        expect(created.body.consensus?.[0]?.enabled).toBe(true)
        expect(created.body.consensus?.[0]?.strategy).toBe('debate')

        // Round-trips through the store on a fresh snapshot read (D1 + Postgres alike).
        const snapshot = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        const reloaded = snapshot.body.pipelines.find((p) => p.id === created.body.id)!
        expect(reloaded.consensus?.[0]?.strategy).toBe('debate')
        expect(reloaded.consensus?.[0]?.participants).toHaveLength(2)
        expect(reloaded.consensus?.[1] ?? null).toBeNull()
      })
    })

    describe('human-testing gate', () => {
      // The gate is a runtime-neutral engine step: it parks for a human, dispatches the
      // Tester's `fixer` from findings, and advances on confirm — identically on every
      // facade. The ephemeral-environment provider is NOT wired in the conformance harness,
      // so the gate runs in its degraded (manual) mode — which still exercises all the
      // engine wiring (routing, park, the pendingAction re-entry + signal, helper dispatch
      // via the shared async executor, the recordStepResult helper-completion hook, advance).
      it('parks for a human, dispatches the fixer on request-fix, and advances on confirm', async () => {
        const app = harness.makeApp({
          asyncKinds: ['coder', 'fixer'],
          // The coder opens a PR so the gate's fixer has a branch to push to.
          pullRequest: {
            url: 'https://github.com/o/r/pull/1',
            number: 1,
            branch: 'feat/login',
          },
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + human test',
          agentKinds: ['coder', 'human-test'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)

        // Drive: the coder runs (async), then the human-test gate parks awaiting the human.
        // With no env provider wired the gate is in degraded (manual) mode — no live env.
        let execs = await app.drive(wsId)
        let exec = execs.find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('blocked')
        let step = exec.steps.find((s) => s.agentKind === 'human-test')!
        expect(step.state).toBe('waiting_decision')
        expect(step.humanTest?.phase).toBe('awaiting_human')
        expect(step.humanTest?.environment ?? null).toBeNull()
        expect(step.humanTest?.degradedReason).toBeTruthy()

        // Request a fix from findings: the gate dispatches the Tester's `fixer` against the
        // PR branch; on its completion the gate re-parks (degraded again, no env to rebuild).
        const fix = await app.call(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/human-test/request-fix`,
          { findings: 'The login button does nothing.' },
        )
        expect(fix.status).toBe(200)
        execs = await app.drive(wsId)
        exec = execs.find((e) => e.blockId === 'task_login')!
        step = exec.steps.find((s) => s.agentKind === 'human-test')!
        expect(step.state).toBe('waiting_decision')
        expect(step.humanTest?.attempts).toBe(1)
        expect(step.humanTest?.rounds?.[0]?.kind).toBe('fix')
        expect(step.humanTest?.rounds?.[0]?.helperKind).toBe('fixer')
        expect(step.humanTest?.rounds?.[0]?.outcome).toBe('completed')

        // Confirm: the gate (the last step) finishes and the run completes.
        const confirm = await app.call(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/human-test/confirm`,
        )
        expect(confirm.status).toBe(200)
        execs = await app.drive(wsId)
        exec = execs.find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        const done = exec.steps.find((s) => s.agentKind === 'human-test')!
        expect(done.state).toBe('done')
        expect(done.humanTest?.phase).toBe('passed')
      })
    })

    describe('prompt-fragment library (managed catalog)', () => {
      it('lists (200 not 503), creates, edits and removes a tier-owned fragment', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/prompt-fragments`

        // The library module is wired on every facade (the test env opts in): a fresh
        // workspace lists no tier-owned fragments (a 200), not the 503 an unconfigured
        // library returns.
        const initial = await call<{ id: string }[]>('GET', base)
        expect(initial.status).toBe(200)
        expect(initial.body).toEqual([])

        // Create a hand-authored fragment at the workspace tier.
        const created = await call<{ id: string; title: string }>('POST', base, {
          id: 'perf',
          title: 'Performance',
          summary: 'Keep the hot path allocation-free.',
          body: 'Avoid allocations in the request hot path; prefer streaming.',
          tags: ['backend'],
        })
        expect(created.status).toBe(201)
        expect(created.body.id).toBe('perf')
        expect(created.body.title).toBe('Performance')

        // It lists back at this tier (the merged/built-in catalog is a separate read).
        const listed = await call<{ id: string }[]>('GET', base)
        expect(listed.body.map((f) => f.id)).toEqual(['perf'])

        // Edit its summary.
        const patched = await call<{ summary: string }>('PATCH', `${base}/perf`, {
          summary: 'Keep the hot path allocation-free and streamed.',
        })
        expect(patched.status).toBe(200)
        expect(patched.body.summary).toBe('Keep the hot path allocation-free and streamed.')

        // Remove it; the tier list goes empty again.
        const del = await call('DELETE', `${base}/perf`)
        expect(del.status).toBe(204)
        const afterDelete = await call<{ id: string }[]>('GET', base)
        expect(afterDelete.body).toEqual([])
      })
    })
  })
}

export function defineIntegrationConformance(harness: ConformanceHarness): void {
  describe(`[${harness.name}] conformance`, () => {
    describe('vendor credentials (subscription token pool)', () => {
      it('adds, lists (secret-free), and removes pooled subscription tokens', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/vendor-credentials`

        // A fresh workspace has an empty pool.
        const initial = await call<{ credentials: unknown[] }>('GET', base)
        expect(initial.status).toBe(200)
        expect(initial.body.credentials).toEqual([])

        // Add two tokens (a pool) for the poolable, organization-permitted coding-plan
        // vendors — the raw token is write-only. (Claude/GLM/ChatGPT-Codex are individual-
        // usage only and are NOT poolable; that is asserted separately below.)
        const first = await call<{ id: string; vendor: string; label: string }>('POST', base, {
          vendor: 'kimi',
          label: 'moonshot',
          token: 'kimi-coding-plan-secret-one',
        })
        expect(first.status).toBe(201)
        expect(first.body.vendor).toBe('kimi')
        // The secret is never echoed back.
        expect(JSON.stringify(first.body)).not.toContain('secret-one')
        const second = await call<{ id: string; vendor: string }>('POST', base, {
          vendor: 'deepseek',
          label: 'deepseek',
          token: 'deepseek-coding-plan-secret-two',
        })
        expect(second.status).toBe(201)
        expect(second.body.vendor).toBe('deepseek')

        // Both list back as metadata only (the unfiltered GET covers every poolable vendor).
        const listed = await call<{ credentials: { id: string; vendor: string }[] }>('GET', base)
        expect(listed.body.credentials).toHaveLength(2)
        expect(listed.body.credentials.map((c) => c.vendor).sort()).toEqual(['deepseek', 'kimi'])
        expect(JSON.stringify(listed.body)).not.toContain('secret-')

        // Remove one; the other survives.
        const del = await call('DELETE', `${base}/${first.body.id}`)
        expect(del.status).toBe(204)
        const afterDelete = await call<{ credentials: { id: string }[] }>('GET', base)
        expect(afterDelete.body.credentials.map((c) => c.id).sort()).toEqual([second.body.id])
      })

      it('refuses to pool any individual-usage subscription (Claude / GLM / Codex)', async () => {
        const { call, createOrgWorkspace } = harness.makeApp()
        // An organization-owned workspace is the case the rule most matters for (pooling an
        // individual-use credential across an org breaches the vendor's terms), but the rule
        // is account-agnostic — these vendors are never poolable on ANY workspace.
        const { workspace } = await createOrgWorkspace()
        const base = `/workspaces/${workspace.id}/vendor-credentials`

        // Every vendor whose own terms license it for individual use only is never poolable
        // on a workspace (409 ConflictError) — they are stored per-user via the
        // personal-subscription endpoints instead.
        for (const [vendor, token] of [
          ['claude', 'sk-ant-oat01-secret'],
          ['glm', 'glm-coding-plan-individual-secret'],
          ['codex', '{"auth_mode":"chatgpt","tokens":{"access_token":"secret"}}'],
        ] as const) {
          const res = await call('POST', base, { vendor, label: 'shared', token })
          expect(res.status).toBe(409)
        }

        // An organization-permitted coding-plan vendor (DeepSeek) carries no restriction.
        const deepseek = await call<{ vendor: string }>('POST', base, {
          vendor: 'deepseek',
          label: 'deepseek',
          token: 'deepseek-coding-plan-secret',
        })
        expect(deepseek.status).toBe(201)
        expect(deepseek.body.vendor).toBe('deepseek')
      })
    })

    describe('provider API keys (DB-backed pool) + provider-gated pipelines', () => {
      // These run with the Cloudflare-AI opt-in forced OFF on every runtime (the Worker
      // binds `AI` in tests, Node never does), so selectability + the start guard depend
      // purely on the DB-backed key pool — and assert identically across runtimes.
      type Opt = {
        id: string
        flavor: string
        available?: boolean
        provider?: string
        model?: string
        contextTokens?: number
        cost?: { inputPerMillion: number; outputPerMillion: number; currency: string }
      }
      const KEY = { provider: 'qwen', label: 'team', key: 'qwen-api-key-secret' }

      it('adds, lists (secret-free), and removes workspace-scoped API keys', async () => {
        const { call, createWorkspace } = harness.makeApp(undefined, {
          cloudflareModelsEnabled: false,
        })
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/api-keys`

        const initial = await call<{ keys: unknown[] }>('GET', base)
        expect(initial.status).toBe(200)
        expect(initial.body.keys).toEqual([])

        const created = await call<{ id: string; provider: string; scope: string }>(
          'POST',
          base,
          KEY,
        )
        expect(created.status).toBe(201)
        expect(created.body.provider).toBe('qwen')
        expect(created.body.scope).toBe('workspace')
        // The raw key is write-only — never echoed back.
        expect(JSON.stringify(created.body)).not.toContain('secret')

        const listed = await call<{ keys: { id: string; provider: string }[] }>('GET', base)
        expect(listed.body.keys).toHaveLength(1)
        expect(JSON.stringify(listed.body)).not.toContain('secret')

        const del = await call('DELETE', `${base}/${created.body.id}`)
        expect(del.status).toBe(204)
        const after = await call<{ keys: unknown[] }>('GET', base)
        expect(after.body.keys).toEqual([])
      })

      it('makes a direct model selectable once its provider key is configured', async () => {
        const { call, createWorkspace } = harness.makeApp(undefined, {
          cloudflareModelsEnabled: false,
        })
        const { workspace } = await createWorkspace()
        const models = `/workspaces/${workspace.id}/models`

        // Cloudflare AI off + no key ⇒ the dual-mode `qwen` model is unselectable.
        const before = await call<Opt[]>('GET', models)
        expect(before.body.find((m) => m.id === 'qwen')?.available).toBe(false)

        await call('POST', `/workspaces/${workspace.id}/api-keys`, KEY)

        // The per-workspace catalog now resolves qwen to its DIRECT flavour, selectable.
        const after = await call<Opt[]>('GET', models)
        const qwen = after.body.find((m) => m.id === 'qwen')!
        expect(qwen.available).toBe(true)
        expect(qwen.flavor).toBe('direct')
      })

      it('makes an OpenRouter (OpenAI-compatible) model selectable once its key is configured', async () => {
        const { call, createWorkspace } = harness.makeApp(undefined, {
          cloudflareModelsEnabled: false,
        })
        const { workspace } = await createWorkspace()
        const models = `/workspaces/${workspace.id}/models`

        // `gemini` is reachable only through the OpenRouter gateway (no Cloudflare/native
        // direct flavour): with no key it is unselectable on both runtimes.
        const before = await call<Opt[]>('GET', models)
        expect(before.body.find((m) => m.id === 'gemini')?.available).toBe(false)

        // Connect an OpenRouter key (exercises the widened apiKeyProviderSchema end to end).
        const created = await call('POST', `/workspaces/${workspace.id}/api-keys`, {
          provider: 'openrouter',
          label: 'team',
          key: 'sk-or-secret',
        })
        expect(created.status).toBe(201)

        // The curated entry now resolves to its OpenRouter gateway flavour, selectable.
        const after = await call<Opt[]>('GET', models)
        const or = after.body.find((m) => m.id === 'gemini')!
        expect(or.available).toBe(true)
        expect(or.flavor).toBe('openrouter')
      })

      it('surfaces an enabled OpenRouter dynamic-catalog model in the per-workspace catalog — identically per store', async () => {
        const app = harness.makeApp(undefined, { cloudflareModelsEnabled: false })
        const probe = app.openRouterCatalog?.()
        // Facades without the API-key pool (no ENCRYPTION_KEY) don't wire the store.
        if (!probe) return
        const { workspace } = await app.createWorkspace()
        const models = `/workspaces/${workspace.id}/models`

        // Connect an OpenRouter key so the gateway is in `directProviders`.
        await app.call('POST', `/workspaces/${workspace.id}/api-keys`, {
          provider: 'openrouter',
          label: 'team',
          key: 'sk-or-secret',
        })

        // Enable one dynamic OpenRouter model with cached context + price.
        const saved = await probe.upsert(workspace.id, {
          models: [
            {
              id: 'x-ai/grok-4',
              name: 'Grok 4',
              contextLength: 256_000,
              inputPerMillion: 3,
              outputPerMillion: 15,
            },
          ],
        })
        expect(saved.models).toHaveLength(1)
        // The enabled subset round-trips through the store (parity across D1 + Postgres).
        expect((await probe.get(workspace.id)).models[0]!.id).toBe('x-ai/grok-4')

        // It now appears in the per-workspace catalog as a selectable openrouter-flavour
        // model, carrying the cached context + the price overlaid onto the spend table.
        const after = await app.call<Opt[]>('GET', models)
        const dyn = after.body.find((m) => m.id === 'openrouter:x-ai/grok-4')!
        expect(dyn.available).toBe(true)
        expect(dyn.flavor).toBe('openrouter')
        expect(dyn.provider).toBe('openrouter')
        expect(dyn.model).toBe('x-ai/grok-4')
        expect(dyn.contextTokens).toBe(256_000)
        expect(dyn.cost?.inputPerMillion).toBe(3)
        expect(dyn.cost?.outputPerMillion).toBe(15)
      })

      it('keeps a base-URL-required provider (LiteLLM) unselectable with a key but no base URL', async () => {
        const { call, createWorkspace } = harness.makeApp(undefined, {
          cloudflareModelsEnabled: false,
        })
        const { workspace } = await createWorkspace()
        const models = `/workspaces/${workspace.id}/models`

        // LiteLLM is operator-hosted: it has NO built-in base URL, and the test env sets
        // no LITELLM_BASE_URL. Connecting a key alone must NOT make it selectable — the
        // run would otherwise pass the start guard and then throw "No base URL configured"
        // at dispatch. (OpenRouter, with a public default, IS selectable on a key — above.)
        const created = await call('POST', `/workspaces/${workspace.id}/api-keys`, {
          provider: 'litellm',
          label: 'team',
          key: 'sk-litellm-secret',
        })
        expect(created.status).toBe(201)

        const after = await call<Opt[]>('GET', models)
        expect(after.body.find((m) => m.id === 'litellm-default')?.available).toBe(false)
      })

      it('blocks starting a pipeline with an unconfigured model, then allows it after a key is added', async () => {
        const { call, createWorkspace } = harness.makeApp(undefined, {
          cloudflareModelsEnabled: false,
        })
        const { workspace } = await createWorkspace()
        const wsId = workspace.id

        // Pin the seeded task to qwen; with Cloudflare off and no key it has no provider.
        await call('PATCH', `/workspaces/${wsId}/blocks/task_login`, { modelId: 'qwen' })
        const blocked = await call<{
          error: { code: string; details?: { reason?: string; models?: string[] } }
        }>('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: 'pl_quick',
        })
        expect(blocked.status).toBe(409)
        // The conflict carries a distinct machine-readable reason (+ the offending model
        // ids) so the SPA can react precisely (open AI setup) instead of string-matching.
        expect(blocked.body.error.code).toBe('conflict')
        expect(blocked.body.error.details?.reason).toBe('providers_unconfigured')
        expect(blocked.body.error.details?.models).toContain('qwen')

        // Configure a qwen key → the guard passes and the run starts.
        await call('POST', `/workspaces/${wsId}/api-keys`, KEY)
        const ok = await call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: 'pl_quick',
        })
        expect(ok.status).toBe(201)
      })
    })

    describe('merge presets', () => {
      it('seeds a default, enforces the single-default invariant, and guards the default', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/merge-presets`

        // First list lazily seeds the built-in default (one preset, flagged default).
        const initial = await call<MergeThresholdPreset[]>('GET', base)
        expect(initial.status).toBe(200)
        expect(initial.body).toHaveLength(1)
        expect(initial.body[0]!.isDefault).toBe(true)
        // The post-release-health knobs round-trip with their defaults through both stores.
        expect(initial.body[0]!.releaseWatchWindowMinutes).toBe(30)
        expect(initial.body[0]!.releaseMaxAttempts).toBe(1)
        const seededDefaultId = initial.body[0]!.id

        // Add a non-default preset; the seeded default stays the default.
        const lenient = await call<MergeThresholdPreset>('POST', base, {
          name: 'Lenient',
          maxComplexity: 0.9,
          maxRisk: 0.8,
          maxImpact: 0.7,
          ciMaxAttempts: 5,
          maxRequirementIterations: 5,
          maxRequirementConcernAllowed: 'medium',
          releaseWatchWindowMinutes: 45,
          releaseMaxAttempts: 2,
        })
        expect(lenient.status).toBe(201)
        expect(lenient.body.isDefault).toBe(false)
        // The requirements-loop + release-health fields round-trip through the store on both runtimes.
        expect(lenient.body.maxRequirementIterations).toBe(5)
        expect(lenient.body.maxRequirementConcernAllowed).toBe('medium')
        expect(lenient.body.releaseWatchWindowMinutes).toBe(45)
        expect(lenient.body.releaseMaxAttempts).toBe(2)

        // Promote a brand-new preset to default; the previous default is demoted
        // (single-default invariant enforced by the repository).
        const strict = await call<MergeThresholdPreset>('POST', base, {
          name: 'Strict',
          maxComplexity: 0.3,
          maxRisk: 0.2,
          maxImpact: 0.2,
          ciMaxAttempts: 10,
          maxRequirementIterations: 2,
          maxRequirementConcernAllowed: 'none',
          isDefault: true,
        })
        expect(strict.status).toBe(201)
        expect(strict.body.isDefault).toBe(true)

        const afterPromote = await call<MergeThresholdPreset[]>('GET', base)
        expect(afterPromote.body).toHaveLength(3)
        const defaults = afterPromote.body.filter((p) => p.isDefault)
        expect(defaults.map((p) => p.id)).toEqual([strict.body.id])
        expect(afterPromote.body.find((p) => p.id === seededDefaultId)!.isDefault).toBe(false)

        // The default cannot be unset via PATCH, nor removed via DELETE.
        const unset = await call('PATCH', `${base}/${strict.body.id}`, { isDefault: false })
        expect(unset.status).toBe(409)
        const delDefault = await call('DELETE', `${base}/${strict.body.id}`)
        expect(delDefault.status).toBe(409)

        // A non-default preset can be patched and removed.
        const renamed = await call<MergeThresholdPreset>('PATCH', `${base}/${lenient.body.id}`, {
          name: 'Lenient v2',
        })
        expect(renamed.status).toBe(200)
        expect(renamed.body.name).toBe('Lenient v2')
        const del = await call('DELETE', `${base}/${lenient.body.id}`)
        expect(del.status).toBe(204)
        const final = await call<MergeThresholdPreset[]>('GET', base)
        expect(final.body.map((p) => p.id).sort()).toEqual([seededDefaultId, strict.body.id].sort())
      })
    })

    describe('local model endpoints (per-user runners)', () => {
      it('stores, lists key-free, resolves with the key, and removes — identically per store', async () => {
        const app = harness.makeApp()
        const probe = app.localModelEndpoints?.()
        // Facades without ENCRYPTION_KEY don't wire the store; nothing to assert there.
        if (!probe) return
        const userId = `usr_local_${Date.now()}`

        // Upsert an Ollama runner with a bearer key + duplicate model ids.
        const created = await probe.upsert(userId, {
          provider: 'ollama',
          baseUrl: 'http://localhost:11434/v1',
          apiKey: 'secret-bearer-key',
          models: ['qwen2.5-coder:32b', 'gemma3', 'qwen2.5-coder:32b'],
        })
        expect(created.provider).toBe('ollama')
        expect(created.hasApiKey).toBe(true)
        // The enabled-models JSON round-trips through the store, de-duplicated.
        expect(created.models).toEqual(['qwen2.5-coder:32b', 'gemma3'])

        // The list (wire) shape never leaks the key.
        const listed = await probe.list(userId)
        expect(listed).toHaveLength(1)
        expect(JSON.stringify(listed)).not.toContain('secret-bearer-key')
        expect(listed[0]!.hasApiKey).toBe(true)
        expect(listed[0]!.models).toEqual(['qwen2.5-coder:32b', 'gemma3'])

        // The run-time resolve path decrypts the key (the proxy / inline provider use this).
        const resolved = await probe.resolve(userId, 'ollama')
        expect(resolved?.baseUrl).toBe('http://localhost:11434/v1')
        expect(resolved?.apiKey).toBe('secret-bearer-key')

        // A second, keyless runner resolves with a null key (the common local case).
        await probe.upsert(userId, {
          provider: 'lmstudio',
          baseUrl: 'http://localhost:1234/v1',
          models: ['llama3.3'],
        })
        const both = await probe.list(userId)
        expect(both.map((e) => e.provider).sort()).toEqual(['lmstudio', 'ollama'])
        expect((await probe.resolve(userId, 'lmstudio'))?.apiKey).toBeNull()

        await probe.remove(userId, 'ollama')
        const after = await probe.list(userId)
        expect(after.map((e) => e.provider)).toEqual(['lmstudio'])
      })

      it('rejects a non-local base URL at the write boundary (anti-SSRF) — identically per store', async () => {
        const app = harness.makeApp()
        const probe = app.localModelEndpoints?.()
        if (!probe) return
        const userId = `usr_local_ssrf_${Date.now()}`

        // A runner lives on the user's own machine/LAN; the base URL is forwarded
        // server-side, so a public host or the link-local metadata endpoint must be
        // refused before anything is persisted.
        for (const baseUrl of [
          'http://evil.example.com/v1',
          'http://169.254.169.254/latest/meta-data',
          'http://8.8.8.8/v1',
        ]) {
          await expect(
            probe.upsert(userId, { provider: 'custom', baseUrl, models: ['m'] }),
          ).rejects.toThrow()
        }
        // Nothing was stored.
        expect(await probe.list(userId)).toEqual([])

        // A loopback URL is still accepted.
        const ok = await probe.upsert(userId, {
          provider: 'custom',
          baseUrl: 'http://127.0.0.1:8080/v1',
          models: ['m'],
        })
        expect(ok.provider).toBe('custom')
        await probe.remove(userId, 'custom')
      })
    })

    describe('user secrets (per-user GitHub PAT)', () => {
      it('stores the secret system-encrypted, resolves it, and describes the kind — identically per store', async () => {
        const app = harness.makeApp()
        const probe = app.userSecrets?.()
        // Facades without ENCRYPTION_KEY don't wire the store; nothing to assert there.
        if (!probe) return
        const userId = `usr_secret_${Date.now()}`

        const stored = await probe.store(userId, 'github_pat', {
          secret: 'ghp_token_123',
          metadata: { apiBase: 'https://ghe.example/api/v3' },
        })
        expect(stored.kind).toBe('github_pat')
        expect(stored.hasSecret).toBe(true)
        expect(stored.metadata).toEqual({ apiBase: 'https://ghe.example/api/v3' })
        // The status never leaks the raw secret.
        expect(JSON.stringify(stored)).not.toContain('ghp_token_123')

        // The run-time resolve path (ResolveUserGitHubToken) decrypts the system-key secret.
        expect(await probe.resolve(userId, 'github_pat')).toBe('ghp_token_123')
        // Absent for another user.
        expect(await probe.resolve(`${userId}_other`, 'github_pat')).toBeNull()

        // The kind self-describes a single secret field + a connection test.
        const descriptor = probe.describe('github_pat')
        expect(descriptor?.supportsTest).toBe(true)
        expect(descriptor?.configFields.find((f) => f.secret)?.key).toBe('token')
      })
    })

    describe('repo bootstrap', () => {
      it('round-trips reference architectures', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/bootstrap/reference-architectures`

        const empty = await call<unknown[]>('GET', base)
        expect(empty.status).toBe(200)
        expect(empty.body).toEqual([])

        const created = await call<{ id: string; name: string }>('POST', base, {
          name: 'Node service',
          repoOwner: 'acme',
          repoName: 'reference-node',
          defaultInstructions: 'Adapt the reference service.',
        })
        expect(created.status).toBe(201)
        expect(created.body.name).toBe('Node service')

        const renamed = await call<{ name: string }>('PATCH', `${base}/${created.body.id}`, {
          name: 'Node service v2',
        })
        expect(renamed.status).toBe(200)
        expect(renamed.body.name).toBe('Node service v2')

        const listed = await call<{ id: string }[]>('GET', base)
        expect(listed.body.map((r) => r.id)).toEqual([created.body.id])

        const del = await call('DELETE', `${base}/${created.body.id}`)
        expect(del.status).toBe(204)
        expect((await call<unknown[]>('GET', base)).body).toEqual([])
      })

      it('drives a bootstrap run to success and materialises its service frame', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        // Kick off a from-scratch bootstrap (the FakeRepoBootstrapper reports connected,
        // so the pre-flight passes). The call returns immediately with a running job that
        // already carries its provisional service frame.
        const started = await app.call<{ id: string; status: string; blockId: string | null }>(
          'POST',
          `/workspaces/${wsId}/bootstrap/jobs`,
          { repoName: 'new-service', instructions: 'Scaffold a small HTTP service.' },
        )
        expect(started.status).toBe(201)
        expect(started.body.status).toBe('running')
        expect(started.body.blockId).toBeTruthy()
        const jobId = started.body.id
        const frameId = started.body.blockId!

        // Drive the durable poll loop (production: pg-boss / a BootstrapWorkflow). The
        // default fake reports `done` on the first poll.
        const polls = await app.driveBootstrap(wsId, jobId)
        expect(polls).toBeGreaterThanOrEqual(1)

        // The job is now succeeded and its service frame is materialised on the board
        // (a real frame, not blocked — the success path flips it ready, after which the
        // best-effort initial blueprint run may move it to in_progress; both are success
        // states and identical across facades, so we assert it isn't the failure state).
        const job = await app.call<{ status: string; blockId: string | null }>(
          'GET',
          `/workspaces/${wsId}/bootstrap/jobs/${jobId}`,
        )
        expect(job.body.status).toBe('succeeded')

        const snap = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        const frame = snap.body.blocks.find((b) => b.id === frameId)
        expect(frame?.level).toBe('frame')
        expect(frame?.status).not.toBe('blocked')
      })
    })

    describe('task sources', () => {
      it('creates a board task from an imported issue and links the issue to it', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace({ seed: false })
        const ws = workspace.id

        // A service frame to create the task inside.
        const frame = await call<Block>('POST', `/workspaces/${ws}/blocks`, {
          type: 'service',
          position: { x: 0, y: 0 },
        })
        expect(frame.status).toBe(201)

        // Connect + import the issue (the fake provider accepts any credentials and
        // generates a deterministic issue), then materialise it as a board task.
        await call('POST', `/workspaces/${ws}/task-sources/jira/connect`, {
          credentials: {
            baseUrl: 'https://acme.atlassian.net',
            accountEmail: 'd@a.io',
            apiToken: 't',
          },
        })
        await call('POST', `/workspaces/${ws}/task-sources/jira/import`, { ref: 'PROJ-42' })

        const created = await call<{ block: Block; task: SourceTask }>(
          'POST',
          `/workspaces/${ws}/tasks/create-block`,
          { source: 'jira', externalId: 'PROJ-42', containerId: frame.body.id },
        )
        expect(created.status).toBe(201)

        // The new block is a leaf task under the frame, seeded from the issue.
        const block = created.body.block
        expect(block.level).toBe('task')
        expect(block.parentId).toBe(frame.body.id)
        expect(block.title).toContain('PROJ-42')
        expect(block.description).toContain('Description for PROJ-42')
        expect(block.status).toBe('planned')

        // The issue is linked to the new task for context, and it's persisted: the
        // board snapshot includes it and the issue list reflects the link.
        expect(created.body.task.linkedBlockId).toBe(block.id)
        const snapshot = await call<WorkspaceSnapshot>('GET', `/workspaces/${ws}`)
        expect(snapshot.body.blocks.some((b) => b.id === block.id && b.level === 'task')).toBe(true)
        const issues = await call<SourceTask[]>('GET', `/workspaces/${ws}/tasks`)
        expect(issues.body.find((t) => t.externalId === 'PROJ-42')?.linkedBlockId).toBe(block.id)

        // Creating a second task from the already-linked issue is refused (409), so the
        // single issue→block link is never silently re-pointed away from the first task.
        const again = await call('POST', `/workspaces/${ws}/tasks/create-block`, {
          source: 'jira',
          externalId: 'PROJ-42',
          containerId: frame.body.id,
        })
        expect(again.status).toBe(409)
      })

      it('404s when the issue was never imported', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace({ seed: false })
        const ws = workspace.id
        const frame = await call<Block>('POST', `/workspaces/${ws}/blocks`, {
          type: 'service',
          position: { x: 0, y: 0 },
        })

        const res = await call('POST', `/workspaces/${ws}/tasks/create-block`, {
          source: 'jira',
          externalId: 'PROJ-999',
          containerId: frame.body.id,
        })
        expect(res.status).toBe(404)
      })

      it('toggles a source off per workspace, gating import, and persists the toggle', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace({ seed: false })
        const ws = workspace.id

        // A connected source starts available + enabled (offered).
        await call('POST', `/workspaces/${ws}/task-sources/jira/connect`, {
          credentials: {
            baseUrl: 'https://acme.atlassian.net',
            accountEmail: 'd@a.io',
            apiToken: 't',
          },
        })
        const before = await call<{ sources: TaskSourceState[] }>(
          'GET',
          `/workspaces/${ws}/task-sources`,
        )
        const jiraBefore = before.body.sources.find((s) => s.source === 'jira')
        expect(jiraBefore?.available).toBe(true)
        expect(jiraBefore?.enabled).toBe(true)

        // Disabling it is refused-from-use and reflected on the source state (persisted).
        const off = await call('PUT', `/workspaces/${ws}/task-sources/jira/enabled`, {
          enabled: false,
        })
        expect(off.status).toBe(204)
        const after = await call<{ sources: TaskSourceState[] }>(
          'GET',
          `/workspaces/${ws}/task-sources`,
        )
        expect(after.body.sources.find((s) => s.source === 'jira')?.enabled).toBe(false)
        const blocked = await call('POST', `/workspaces/${ws}/task-sources/jira/import`, {
          ref: 'PROJ-7',
        })
        expect(blocked.status).toBe(409)

        // Re-enabling restores import.
        await call('PUT', `/workspaces/${ws}/task-sources/jira/enabled`, { enabled: true })
        const ok = await call('POST', `/workspaces/${ws}/task-sources/jira/import`, {
          ref: 'PROJ-7',
        })
        expect(ok.status).toBe(201)
      })

      it('runs a live setup-check, gating on connection then delegating to the provider', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace({ seed: false })
        const ws = workspace.id

        // A credentialed source with no connection yet reports `not_connected` —
        // the service gates on availability before it would ever probe.
        const before = await call<TaskSourceDiagnostic>(
          'POST',
          `/workspaces/${ws}/task-sources/jira/diagnostics`,
        )
        expect(before.status).toBe(200)
        expect(before.body.ok).toBe(false)
        expect(before.body.status).toBe('not_connected')

        // Once connected, the check delegates to the provider's live probe (the fake
        // returns a ready verdict), so a configured source reports ready.
        await call('POST', `/workspaces/${ws}/task-sources/jira/connect`, {
          credentials: {
            baseUrl: 'https://acme.atlassian.net',
            accountEmail: 'd@a.io',
            apiToken: 't',
          },
        })
        const after = await call<TaskSourceDiagnostic>(
          'POST',
          `/workspaces/${ws}/task-sources/jira/diagnostics`,
        )
        expect(after.status).toBe(200)
        expect(after.body.ok).toBe(true)
        expect(after.body.status).toBe('ready')
      })
    })

    describe('document sources', () => {
      it('connects, lists (secret-free), and disconnects a document source', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/document-sources`

        // The module is wired on every facade: a fresh workspace lists no connections
        // (a 200), not the 503 a missing documents module would return.
        const initial = await call<{ connections: { source: string }[] }>(
          'GET',
          `${base}/connections`,
        )
        expect(initial.status).toBe(200)
        expect(initial.body.connections).toEqual([])

        // Connect Notion (a single internal-integration token; normalizeConnection is
        // pure, so no network). The credential is encrypted at rest and never echoed.
        const connected = await call<{ source: string; label: string }>(
          'POST',
          `${base}/notion/connect`,
          { credentials: { apiToken: 'secret-notion-token-xyz' } },
        )
        expect(connected.status).toBe(201)
        expect(connected.body.source).toBe('notion')
        expect(JSON.stringify(connected.body)).not.toContain('secret-notion-token')

        // It lists back as metadata only — the token is never on the wire.
        const listed = await call<{ connections: { source: string }[] }>(
          'GET',
          `${base}/connections`,
        )
        expect(listed.body.connections.map((c) => c.source)).toEqual(['notion'])
        expect(JSON.stringify(listed.body)).not.toContain('secret-notion-token')

        // Disconnect tombstones it; the list goes empty again.
        const del = await call('DELETE', `${base}/notion/connection`)
        expect(del.status).toBe(204)
        const afterDelete = await call<{ connections: unknown[] }>('GET', `${base}/connections`)
        expect(afterDelete.body.connections).toEqual([])
      })
    })

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
          { manifest, secrets: { API_TOKEN: 'super-secret-env-token' } },
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
          manifest,
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
          manifest,
          secrets: { API_TOKEN: 't' },
        })
        // A validation failure (the SSRF/internal-host guard), not a 201.
        expect(res.status).toBeGreaterThanOrEqual(400)
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

        const bad = await app.call(
          'POST',
          `/workspaces/${workspace.id}/blocks/task_login/modules`,
          {
            name: 'Nope',
          },
        )
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
        const first = await app.call('DELETE', `/workspaces/${workspace.id}/blocks/blk_auth`)
        expect(first.status).toBe(204)
        const again = await app.call('DELETE', `/workspaces/${workspace.id}/blocks/blk_auth`)
        expect(again.status).toBe(204)
        const unknown = await app.call('DELETE', `/workspaces/${workspace.id}/blocks/blk_nope`)
        expect(unknown.status).toBe(204)
      })
    })
  })
}

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
        // `tester`, so its `tester.environment` descriptor must be present on BOTH stores.
        const snap0 = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
        expect(snap0.agentConfigCatalog?.some((d) => d.id === 'tester.environment')).toBe(true)

        // A task created with an explicit agent-config value round-trips through the store.
        const created = await app.call<Block>(
          'POST',
          `/workspaces/${wsId}/blocks/mod_sessions/tasks`,
          { title: 'Configured task', agentConfig: { 'tester.environment': 'local' } },
        )
        expect(created.status).toBe(201)
        expect(created.body.agentConfig).toEqual({ 'tester.environment': 'local' })

        const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
        const task = snap.blocks.find((b) => b.id === created.body.id)!
        expect(task.agentConfig).toEqual({ 'tester.environment': 'local' })
      })

      it('blocks a local-mode Tester pipeline until the service test infra is configured', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Code + test',
          agentKinds: ['coder', 'tester'],
        })
        // Opt the task into LOCAL testing without configuring the service's infra.
        await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
          agentConfig: { 'tester.environment': 'local' },
        })
        const blocked = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(blocked.status).toBeGreaterThanOrEqual(400)

        // Mark the service frame as having no infra dependencies → the start succeeds.
        const blocks = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body.blocks
        const task = blocks.find((b) => b.id === 'task_login')!
        // In the seed `task_login` is a task directly under the `blk_auth` service
        // frame (no intervening module), so its parent IS the service frame to
        // configure — matching how the engine resolves service config (walk up to the
        // nearest `level:'frame'` ancestor).
        const serviceFrameId = task.parentId!
        await app.call('PATCH', `/workspaces/${wsId}/blocks/${serviceFrameId}`, {
          noInfraDependencies: true,
        })
        const ok = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(ok.status).toBe(201)
      })

      it('a task inherits the service frame default test environment, and a per-task override wins', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Code + test',
          agentKinds: ['coder', 'tester'],
        })

        // Default the SERVICE frame to LOCAL testing without touching the task's own
        // agent-config. `task_login` sits directly under its service frame.
        const blocks = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body.blocks
        const serviceFrameId = blocks.find((b) => b.id === 'task_login')!.parentId!
        await app.call('PATCH', `/workspaces/${wsId}/blocks/${serviceFrameId}`, {
          defaultTestEnvironment: 'local',
        })

        // The task INHERITS `local`, so the start guard blocks until the service infra is
        // configured — proving the frame default (not the built-in `ephemeral`) reached the
        // engine's resolution on this runtime.
        const inheritedBlocked = await app.call(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(inheritedBlocked.status).toBeGreaterThanOrEqual(400)

        // A per-task override to `ephemeral` WINS over the service default → the run starts
        // with no infra configured.
        await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
          agentConfig: { 'tester.environment': 'ephemeral' },
        })
        const overridden = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(overridden.status).toBe(201)
      })

      it('loops the fixer until the tester greenlights, then completes', async () => {
        // Drive the Tester→Fixer loop on BOTH runtimes: the first report withholds its
        // greenlight (the engine dispatches the fixer and re-tests), the second greenlights.
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
          asyncKinds: ['coder', 'tester', 'fixer'],
          asyncPolls: 1,
          testReports: [notGreen, green],
          pullRequest: { url: 'https://gh/pr/1', number: 1, branch: 'cat-factory/task_login' },
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Code + test loop',
          agentKinds: ['coder', 'tester'],
        })
        // Ephemeral mode keeps the start guard happy without service infra config.
        await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
          agentConfig: { 'tester.environment': 'ephemeral' },
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
        const testerStep = exec.steps.find((s) => s.agentKind === 'tester')!
        expect(testerStep.state).toBe('done')
        // One fixer attempt was dispatched, and the final report greenlit.
        expect(testerStep.test?.attempts).toBe(1)
        expect(testerStep.test?.lastReport?.greenlight).toBe(true)
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
          asyncKinds: ['coder', 'tester', 'fixer'],
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
          agentKinds: ['coder', 'tester'],
        })
        await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
          agentConfig: { 'tester.environment': 'ephemeral' },
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        const testerStep = exec.steps.find((s) => s.agentKind === 'tester')!
        expect(testerStep.state).toBe('done')
        // The first-round nit looped the fixer exactly once; the second-round nit was advisory.
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
          asyncKinds: ['tester', 'fixer'],
          asyncPolls: 1,
          testReports: [bogusGreen],
          // No pullRequest → no branch for the fixer to push to → terminal failure.
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Test only',
          agentKinds: ['tester'],
        })
        await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
          agentConfig: { 'tester.environment': 'ephemeral' },
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('failed')
        const testerStep = exec.steps.find((s) => s.agentKind === 'tester')!
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
          { itemIds: ['rri_seed_task_login'] },
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
        // The step did not falsely complete; the cold-boot flag was cleared.
        const coderStep = exec.steps.find((s) => s.agentKind === 'coder')!
        expect(coderStep.state).not.toBe('done')
        expect(coderStep.startingContainer ?? false).toBe(false)
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
        await app.drive(wsId)
        const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
        const task = snap.blocks.find((b) => b.id === 'task_login')!
        expect(task.status).toBe('pr_ready')
        expect(task.status).not.toBe('done')
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
        await app.drive(wsId)
        const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
        const task = snap.blocks.find((b) => b.id === 'task_login')!
        // The merge ran at the (non-final) merger step → the block is `done`, not left
        // unmerged as `pr_ready`.
        expect(task.status).toBe('done')
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
        // enforces that adjacency on EVERY facade. ['coder','tester','reviewer'] slips
        // `tester` between the coder and its `reviewer` companion, so the pipeline save is
        // rejected (a `validation` domain error → 422) before any run is created.
        const app = harness.makeApp({ confidence: 1 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const res = await app.call('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + gap companion',
          agentKinds: ['coder', 'tester', 'reviewer'],
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
        const app = harness.makeApp({ confidence: 1, asyncKinds: ['coder'], asyncPolls: 2 })
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
        // The "spinning up container" phase flag is set at dispatch and must be
        // cleared once the container is up — a finished step never reads as booting.
        expect(coder.startingContainer ?? false).toBe(false)
        // The model is known at dispatch (the moment the ref resolves, before the
        // container is up), so it must ALREADY be present on the first "spinning up
        // container" emit — not only once the job's result lands. Asserting it on the
        // booting emit pins the early preview so it can't regress on either runtime.
        const booting = app
          .executionEmits('task_login')
          .map((e) => e.steps.find((s) => s.agentKind === 'coder'))
          .find((s) => s?.startingContainer === true)
        expect(booting, 'expected a "spinning up container" emit for the coder step').toBeTruthy()
        expect(booting!.model).toBe('fake')

        const task = (
          await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        ).body.blocks.find((b) => b.id === 'task_login')!
        expect(task.status).toBe('done')
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
    })
  })
}

export function defineMiscConformance(harness: ConformanceHarness): void {
  describe(`[${harness.name}] conformance`, () => {
    describe('recurring pipelines', () => {
      const recurrence = {
        intervalHours: 24,
        weekdays: [] as number[],
        windowStartHour: null,
        windowEndHour: null,
        timezone: 'UTC',
      }

      it('creates a schedule with a reused block and surfaces it on the snapshot', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const created = await app.call<PipelineSchedule>(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines`,
          { frameId: 'blk_auth', pipelineId: 'pl_dep_update', name: 'Weekly deps', recurrence },
        )
        expect(created.status).toBe(201)
        expect(created.body.frameId).toBe('blk_auth')
        expect(created.body.nextRunAt).toBeGreaterThan(0)

        // The schedule materialised a reused task block under the service frame.
        const snapshot = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        const block = snapshot.body.blocks.find((b) => b.id === created.body.blockId)
        expect(block?.parentId).toBe('blk_auth')
        expect(block?.level).toBe('task')
        expect(snapshot.body.recurringPipelines?.map((s) => s.id)).toContain(created.body.id)

        // Listing + deletion (which removes the reused block too).
        const list = await app.call<PipelineSchedule[]>(
          'GET',
          `/workspaces/${wsId}/recurring-pipelines`,
        )
        expect(list.body).toHaveLength(1)
        const del = await app.call(
          'DELETE',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}`,
        )
        expect(del.status).toBe(204)
        const after = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        expect(after.body.blocks.find((b) => b.id === created.body.blockId)).toBeUndefined()
      })

      it('run-now starts an execution on the reused block and records run history', async () => {
        const app = harness.makeApp({ confidence: 1 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        // A single-step inline pipeline keeps the run deterministic across runtimes.
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Recurring inline',
          agentKinds: ['architect'],
        })
        const created = await app.call<PipelineSchedule>(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines`,
          { frameId: 'blk_auth', pipelineId: pipeline.body.id, name: 'Nightly', recurrence },
        )

        const fired = await app.call(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}/run-now`,
        )
        expect(fired.status).toBe(200)

        // A running history row pointing at a real execution on the schedule's block.
        const running = await app.call<ScheduleRun[]>(
          'GET',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}/runs`,
        )
        expect(running.body).toHaveLength(1)
        expect(running.body[0]!.executionId).toBeTruthy()

        // Drive it to completion; the history (overlaid with live status) shows done.
        const driven = await app.drive(wsId)
        expect(driven.find((e) => e.blockId === created.body.blockId)?.status).toBe('done')
        const done = await app.call<ScheduleRun[]>(
          'GET',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}/runs`,
        )
        expect(done.body[0]!.status).toBe('done')

        // A second run-now while the (now-finished) run exists still works; firing
        // twice in a row never starts two concurrent runs on the same block.
        const again = await app.call(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}/run-now`,
        )
        expect(again.status).toBe(200)
      })

      it('reads and writes the workspace tracker selection', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const initial = await app.call<TrackerSettings>(
          'GET',
          `/workspaces/${wsId}/tracker-settings`,
        )
        expect(initial.status).toBe(200)
        expect(initial.body.tracker).toBeNull()

        const put = await app.call<TrackerSettings>('PUT', `/workspaces/${wsId}/tracker-settings`, {
          tracker: 'jira',
          jiraProjectKey: 'ENG',
          writebackCommentOnPrOpen: true,
          writebackResolveOnMerge: true,
        })
        expect(put.body.tracker).toBe('jira')
        expect(put.body.jiraProjectKey).toBe('ENG')
        // Writeback flags round-trip identically across both stores.
        expect(put.body.writebackCommentOnPrOpen).toBe(true)
        expect(put.body.writebackResolveOnMerge).toBe(true)

        const snapshot = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        expect(snapshot.body.trackerSettings?.tracker).toBe('jira')
        expect(snapshot.body.trackerSettings?.writebackResolveOnMerge).toBe(true)
      })

      it('round-trips the per-task writeback overrides on a block', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const task = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
          title: 'Task with writeback overrides',
        })

        const patched = await app.call<Block>(
          'PATCH',
          `/workspaces/${wsId}/blocks/${task.body.id}`,
          { trackerCommentOnPrOpen: 'on', trackerResolveOnMerge: 'off' },
        )
        expect(patched.body.trackerCommentOnPrOpen).toBe('on')
        expect(patched.body.trackerResolveOnMerge).toBe('off')

        // The overrides survive a snapshot round-trip identically across both stores.
        const snapshot = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        const stored = snapshot.body.blocks.find((b) => b.id === task.body.id)!
        expect(stored.trackerCommentOnPrOpen).toBe('on')
        expect(stored.trackerResolveOnMerge).toBe('off')

        // Clearing an override (back to inheriting the workspace setting) drops the field.
        const cleared = await app.call<Block>(
          'PATCH',
          `/workspaces/${wsId}/blocks/${task.body.id}`,
          { trackerCommentOnPrOpen: null },
        )
        expect(cleared.body.trackerCommentOnPrOpen ?? null).toBeNull()
        expect(cleared.body.trackerResolveOnMerge).toBe('off')
      })
    })

    // Slack is an extra notification transport; both facades wire the same module +
    // channel. These assert the per-workspace routing and the per-account member map
    // persist + read back identically on each store (the persistence-parity concern).
    // Connecting a workspace (auth.test / OAuth) needs real Slack network, so it is
    // exercised by the integration package's unit tests, not here.
    describe('slack', () => {
      it('round-trips per-workspace notification routing', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        // A workspace that never configured Slack reads back the (no-op) defaults.
        const initial = await app.call<SlackNotificationSettings>(
          'GET',
          `/workspaces/${wsId}/slack/settings`,
        )
        expect(initial.status).toBe(200)
        expect(initial.body.mentionsEnabled).toBe(false)

        const put = await app.call<SlackNotificationSettings>(
          'PUT',
          `/workspaces/${wsId}/slack/settings`,
          {
            routes: { merge_review: { enabled: true, channel: '#releases' } },
            mentionsEnabled: true,
          },
        )
        expect(put.status).toBe(200)
        expect(put.body.routes.merge_review).toEqual({ enabled: true, channel: '#releases' })
        expect(put.body.mentionsEnabled).toBe(true)

        const after = await app.call<SlackNotificationSettings>(
          'GET',
          `/workspaces/${wsId}/slack/settings`,
        )
        expect(after.body.routes.merge_review?.channel).toBe('#releases')
        expect(after.body.mentionsEnabled).toBe(true)
      })

      it('round-trips the per-account member mapping (de-duped by github user id)', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const empty = await app.call<{ entries: SlackMemberMappingEntry[] }>(
          'GET',
          `/workspaces/${wsId}/slack/member-mapping`,
        )
        expect(empty.status).toBe(200)
        expect(empty.body.entries).toEqual([])

        const put = await app.call<{ entries: SlackMemberMappingEntry[] }>(
          'PUT',
          `/workspaces/${wsId}/slack/member-mapping`,
          {
            entries: [
              { userId: 'usr_1', slackUserId: 'U1', role: 'engineering' },
              { userId: 'usr_1', slackUserId: 'U1b', role: 'product' },
              { userId: 'usr_2', slackUserId: 'U2', role: 'product' },
            ],
          },
        )
        expect(put.status).toBe(200)
        // De-duped by user id (last write wins): 2 entries, not 3.
        expect(put.body.entries).toHaveLength(2)
        expect(put.body.entries.find((e) => e.userId === 'usr_1')?.slackUserId).toBe('U1b')

        const after = await app.call<{ entries: SlackMemberMappingEntry[] }>(
          'GET',
          `/workspaces/${wsId}/slack/member-mapping`,
        )
        expect(after.body.entries).toHaveLength(2)
        // The notification role round-trips on both stores (drives @-mention audience).
        expect(after.body.entries.find((e) => e.userId === 'usr_1')?.role).toBe('product')
        expect(after.body.entries.find((e) => e.userId === 'usr_2')?.role).toBe('product')
      })
    })

    // The user-identity + onboarding layer (users / user_identities / invitations).
    // Driven through the facade's real services + store so a repository that maps a
    // column differently, or a facade that forgot to wire the identity layer, fails the
    // same assertion on every runtime. A unique email suffix keeps the persisted store
    // (shared across a file's tests) collision-free.
    describe('identity & onboarding', () => {
      const uniqueEmail = (local: string) => `${local}-${crypto.randomUUID()}@conformance.test`

      it('creates a user on first identity sight and is idempotent on (provider, subject)', async () => {
        const ob = harness.makeApp().onboarding()
        const email = uniqueEmail('gh')
        const subject = uniqueEmail('sub-gh')
        const first = await ob.users.findOrCreateByIdentity('github', subject, {
          name: 'Octo Cat',
          email,
          emailVerified: true,
        })
        expect(first.id).toMatch(/^usr_/)
        expect(first.email).toBe(email.toLowerCase())

        // A repeat login for the same (provider, subject) returns the SAME user.
        const again = await ob.users.findOrCreateByIdentity('github', subject, { email })
        expect(again.id).toBe(first.id)
        expect((await ob.users.findByIdentity('github', subject))?.id).toBe(first.id)
        expect((await ob.users.get(first.id))?.id).toBe(first.id)
        const identities = await ob.users.listIdentities(first.id)
        expect(identities.some((i) => i.provider === 'github')).toBe(true)
      })

      it('links a second VERIFIED-email provider onto the same user (no email collision)', async () => {
        const ob = harness.makeApp().onboarding()
        const email = uniqueEmail('shared')
        const viaGithub = await ob.users.findOrCreateByIdentity('github', uniqueEmail('s-gh'), {
          email,
          emailVerified: true,
        })
        const viaGoogle = await ob.users.findOrCreateByIdentity('google', uniqueEmail('s-goog'), {
          email,
          emailVerified: true,
        })
        // Same person, two logins — NOT a duplicate user / unique-index collision.
        expect(viaGoogle.id).toBe(viaGithub.id)
        const identities = await ob.users.listIdentities(viaGithub.id)
        expect(identities.map((i) => i.provider).sort()).toEqual(['github', 'google'])
      })

      it('does NOT merge accounts on an UNVERIFIED same-email login', async () => {
        const ob = harness.makeApp().onboarding()
        const email = uniqueEmail('unver')
        const verified = await ob.users.findOrCreateByIdentity('github', uniqueEmail('u-gh'), {
          email,
          emailVerified: true,
        })
        const unverified = await ob.users.findOrCreateByIdentity('google', uniqueEmail('u-goog'), {
          email,
          emailVerified: false,
        })
        // An unverified email is never trusted to claim the existing user — the second
        // identity creates a distinct user (its own email stays null to avoid the index).
        expect(unverified.id).not.toBe(verified.id)
        expect(unverified.email).toBeNull()
      })

      it('does NOT merge a verified login onto a password-squatted email (pre-hijack guard)', async () => {
        const ob = harness.makeApp().onboarding()
        const email = uniqueEmail('squat')
        // A password signup self-asserts the email without proving ownership.
        const squatter = await ob.users.signupWithPassword({ email, password: 'squatter pass' })
        // A genuinely-verified OAuth login for the same address must NOT land on the
        // squatter's account — it takes the email onto a fresh, distinct user.
        const victim = await ob.users.findOrCreateByIdentity('google', uniqueEmail('victim'), {
          email,
          emailVerified: true,
        })
        expect(victim.id).not.toBe(squatter.id)
        expect(victim.email).toBe(email.toLowerCase())
        // The email is released from the squatting, password-only account.
        expect((await ob.users.get(squatter.id))?.email).toBeNull()
      })

      it('signs up + verifies a password user, and rejects duplicate email / bad password', async () => {
        const ob = harness.makeApp().onboarding()
        const email = uniqueEmail('pw')
        const user = await ob.users.signupWithPassword({
          email,
          password: 'correct horse battery',
          name: 'PW User',
        })
        expect(user.id).toMatch(/^usr_/)

        // Right password verifies to the same user; wrong password + unknown email → null.
        const ok = await ob.users.verifyPassword({ email, password: 'correct horse battery' })
        expect(ok?.id).toBe(user.id)
        expect(await ob.users.verifyPassword({ email, password: 'wrong' })).toBeNull()
        expect(
          await ob.users.verifyPassword({ email: uniqueEmail('nope'), password: 'whatever' }),
        ).toBeNull()

        // A second signup for the same email is refused (no duplicate / takeover).
        await expect(
          ob.users.signupWithPassword({ email, password: 'another password' }),
        ).rejects.toMatchObject({ name: 'ConflictError' })
      })

      it('invites + redeems org membership bound to the invited email', async () => {
        const app = harness.makeApp()
        const ob = app.onboarding()
        if (!ob.invitations) return // facade without the invitation repository wired
        const invitations = ob.invitations
        const org = await ob.makeOrgOwner('Conformance Org')

        const inviteeEmail = uniqueEmail('invitee')
        const invitee = await ob.users.findOrCreateByIdentity('google', uniqueEmail('inv-goog'), {
          email: inviteeEmail,
          emailVerified: true,
        })
        const created = await invitations.invite(org.accountId, org.ownerUserId, inviteeEmail)
        const peeked = await invitations.peek(created.token)
        expect(peeked?.accountId).toBe(org.accountId)
        expect(peeked?.email).toBe(inviteeEmail.toLowerCase())

        // A mismatched email cannot redeem the invite (leaked-link / allowlist-bypass guard).
        await expect(
          invitations.accept(created.token, invitee.id, 'someone-else@conformance.test'),
        ).rejects.toMatchObject({ name: 'ConflictError' })

        // The intended invitee redeems and gains membership.
        const accountId = await invitations.accept(created.token, invitee.id, inviteeEmail)
        expect(accountId).toBe(org.accountId)
        const members = await ob.members(org.accountId)
        expect(members.some((m) => m.userId === invitee.id)).toBe(true)
      })
    })
  })
}

// The aggregate the Cloudflare Worker runs (one file → one D1, `singleWorker`): every
// group, each self-wrapping in its own `[name] conformance` describe block. The Postgres
// runtimes instead call the individual group functions from separate spec files so they
// parallelise across vitest workers.
export function defineConformanceSuite(harness: ConformanceHarness): void {
  defineCoreConformance(harness)
  defineAgentConformance(harness)
  defineIntegrationConformance(harness)
  defineExecutionConformance(harness)
  defineMiscConformance(harness)
}
