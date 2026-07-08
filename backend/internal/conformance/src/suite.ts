import {
  type Block,
  BUG_TRIAGE_PIPELINE_ID,
  type ExecutionInstance,
  type Initiative,
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
import { allPullRequests } from '@cat-factory/contracts'
import {
  clearRegisteredPromptFragments,
  registerPromptFragment,
} from '@cat-factory/prompt-fragments'
import { defaultAgentKindRegistry, resolveDocTemplate } from '@cat-factory/agents'
import {
  composeEnvironmentBackend,
  createBackendRegistries,
  type ComposeRuntime,
  type EnvironmentBackendProvider,
  type RunnerBackendProvider,
} from '@cat-factory/integrations'
// The built-in gate suite lives in its own package and registers via the public seam (the
// dogfood). The suite imports it so the runtime-neutral assertions run with the SAME gates a
// real deployment ships, and so a test that clears the registry can restore them.
import { clearGateProviders, registerBuiltinGates } from '@cat-factory/gates'
import type {
  BinaryArtifactStore,
  CiStatusProvider,
  DeployCloneTarget,
  DocQualityProvider,
  DocumentRecord,
  EnvironmentProvider,
  GateProbe,
  Notification,
  PullRequestReviewProvider,
  PullRequestReviewSnapshot,
  RepoFiles,
  RepoValidationResult,
  ResolveBinaryArtifactStore,
  RunnerJobRef,
  RunnerJobView,
  RunRepoContext,
} from '@cat-factory/kernel'
import {
  clearRegisteredGates,
  clearRegisteredInitiativePresets,
  clearRegisteredStepResolvers,
  registerGate,
  registerInitiativePreset,
  registerStepResolver,
} from '@cat-factory/kernel'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConformanceHarness } from './harness.js'
import { FakeTesterQualityReviewer } from './FakeTesterQualityReviewer.js'
import { FakeTaskSourceProvider } from './FakeTaskSourceProvider.js'

// Binary-storage start-gate helpers (see the `visual-confirmation` / UI-tester tests).
// The Worker test env binds R2 (storage ON by default) while Node/local default to OFF and
// the two share no configurable backend, so the suite injects the resolver directly to drive
// the gate identically on every runtime: a non-null store ⇒ a storage-reliant pipeline starts,
// a null-returning resolver ⇒ it is refused with `binary_storage_unconfigured`.
const EMPTY_BINARY_ARTIFACT_STORE: BinaryArtifactStore = {
  store: () => Promise.reject(new Error('not used in conformance')),
  getMetadata: () => Promise.resolve(null),
  getBlob: () => Promise.resolve(null),
  getBlobWithMetadata: () => Promise.resolve(null),
  listByExecution: () => Promise.resolve([]),
  countByExecution: () => Promise.resolve(0),
  listByBlock: () => Promise.resolve([]),
  delete: () => Promise.resolve(),
  pruneOlderThan: () => Promise.resolve(0),
}
/** Storage configured: every workspace resolves the (empty) store, so the gate is satisfied. */
const STORAGE_ON: ResolveBinaryArtifactStore = () => Promise.resolve(EMPTY_BINARY_ARTIFACT_STORE)
/** Storage off: the account has no content storage, so the start gate must refuse the run. */
const STORAGE_OFF: ResolveBinaryArtifactStore = () => Promise.resolve(null)

/**
 * A minimal `executing` initiative entity created from the `preset_spawned_conf` preset, anchored to
 * `anchorBlockId`. Seeded directly so the spawned-run preset-context assertion (D1) can link a task
 * to it via `block.initiativeId` without driving a whole planning loop.
 */
function spawnedInitiative(anchorBlockId: string): Initiative {
  return {
    id: `initv-${anchorBlockId}`,
    blockId: anchorBlockId,
    slug: 'connector-factory',
    title: 'Connector factory',
    presetId: 'preset_spawned_conf',
    goal: '',
    constraints: [],
    nonGoals: [],
    qa: [],
    analysisSummary: '',
    phases: [],
    items: [],
    policy: null,
    decisions: [],
    deviations: [],
    followUps: [],
    caveats: [],
    status: 'executing',
    rev: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}

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
    describe('infrastructure capabilities', () => {
      it('exposes execution + test-env backends on /auth/config with active ∈ available', async () => {
        const { call } = harness.makeApp()
        const res = await call<{
          infrastructure?: {
            execution: { available: string[]; active: string }
            testEnv: { available: string[]; active: string }
            frontendPreview: { supported: boolean }
          }
        }>('GET', '/auth/config')
        expect(res.status).toBe(200)
        // Every facade must populate the descriptor (it drives the SPA's infra selector).
        const infra = res.body.infrastructure
        expect(infra).toBeTruthy()
        expect(infra!.execution.available.length).toBeGreaterThan(0)
        expect(infra!.execution.available).toContain(infra!.execution.active)
        expect(infra!.testEnv.available.length).toBeGreaterThan(0)
        expect(infra!.testEnv.available).toContain(infra!.testEnv.active)
        // The browsable-preview capability is a required boolean axis on every facade (the SPA
        // gates the `previewEnabled` toggle on it). Its VALUE is a per-facade differentiator
        // (Worker false; Node/local true), so the shared suite pins only that it is present +
        // boolean — each facade's own spec asserts its concrete value.
        expect(typeof infra!.frontendPreview.supported).toBe('boolean')
      })
    })

    describe('mothership-mode machine API', () => {
      it('serves /internal/persistence with the registry attached + machine-token gate active', async () => {
        const { call } = harness.makeApp()
        // The endpoint is mounted by the shared controller and the session auth gate bypasses
        // `/internal`, so an unauthenticated call reaches the controller. With the facade's
        // repository registry attached (both runtimes must do this — the symmetric wiring), a
        // missing/invalid machine token is rejected 403. A facade that FORGOT to attach its
        // registry would instead 503 here, so this is the drift guard for that symmetric change.
        const res = await call('POST', '/internal/persistence', {
          repo: 'workspaceRepository',
          method: 'get',
          args: ['ws_x'],
        })
        expect(res.status).toBe(403)
      })
    })

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

      it('computes the infra-setup status projection on the snapshot (both create + read)', async () => {
        // The shared controller derives `infraSetup` from whatever THIS deployment wired, so its
        // per-area values legitimately differ across runtimes (e.g. the Worker binds R2 →
        // binaryStorage `configured`; a stock Node deployment defaults to off → `not_defined`).
        // The runtime-agnostic invariant the conformance suite pins is that BOTH facades attach
        // the projection with all three areas set to a valid status — a facade that forgot it (or
        // mistyped a value) fails here rather than shipping a banner that never renders.
        const statuses = ['not_defined', 'configured', 'not_applicable']
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace({ seed: false })

        const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${workspace.id}`)
        const infra = snap.body.infraSetup
        expect(infra).toBeDefined()
        expect(statuses).toContain(infra!.ephemeralEnvironments)
        expect(statuses).toContain(infra!.agentExecutor)
        expect(statuses).toContain(infra!.binaryStorage)

        // The create response carries the same projection (so a fresh board renders the banner).
        const created = await call<WorkspaceSnapshot>('POST', '/workspaces', { seed: false })
        expect(created.body.infraSetup).toBeDefined()
        expect(statuses).toContain(created.body.infraSetup!.binaryStorage)
      })

      it('advertises the registered initiative presets on the snapshot (both create + read)', async () => {
        // The initiative-preset registry is process-global, so the shared WorkspaceController
        // attaches `initiativePresets` for BOTH facades. The runtime-agnostic invariant: the
        // built-in generic preset is always present, binds the generic planning pipeline, and
        // runs the interviewer — a facade that dropped the field (or a broken registry read)
        // fails here rather than shipping an empty create picker.
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace({ seed: false })

        const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${workspace.id}`)
        const generic = snap.body.initiativePresets?.find((p) => p.id === 'preset_generic')
        expect(generic).toBeDefined()
        expect(generic!.planningPipelineId).toBe('pl_initiative')
        expect(generic!.interview).toBe('full')
        // The generic preset has no `detect` hook, so its `probe` flag is derived false.
        expect(generic!.probe ?? false).toBe(false)

        // The create response carries the same registry projection.
        const created = await call<WorkspaceSnapshot>('POST', '/workspaces', { seed: false })
        expect(created.body.initiativePresets?.some((p) => p.id === 'preset_generic')).toBe(true)
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

      it('returns blocks in insertion order on every store, stable across updates', async () => {
        // Parity pin: D1 lists blocks `ORDER BY rowid` (insertion order); the Postgres
        // store must match via its `seq` column. Enough fat rows to span several heap
        // pages + an update to the FIRST one make the drift observable: without an
        // ORDER BY, Postgres relocates the updated row's new tuple version to a later
        // page, so a bare heap read returns it out of insertion order.
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const wsId = workspace.id

        const filler = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(12)
        const createdIds: string[] = []
        for (let i = 0; i < 40; i++) {
          const res = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
            title: `Ordered task ${i}`,
            description: filler,
          })
          expect(res.status).toBe(201)
          createdIds.push(res.body.id)
        }
        const updated = await call('PATCH', `/workspaces/${wsId}/blocks/${createdIds[0]}`, {
          title: 'Ordered task 0, renamed',
          description: `${filler} Updated so the row version moves in the heap.`,
        })
        expect(updated.status).toBe(200)

        const snapshot = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        const createdSet = new Set(createdIds)
        const listed = snapshot.body.blocks.map((b) => b.id).filter((id) => createdSet.has(id))
        expect(listed).toEqual(createdIds)
      })
    })

    describe('execution optimistic concurrency (compareAndSwap)', () => {
      // The lost-update fix: a human-action write that raced another writer must be REFUSED
      // (so the loser re-reads and retries) rather than blindly clobbering the run snapshot.
      // Asserted at the repository layer so D1 and Postgres are proven to behave identically.
      it('refuses a stale compareAndSwap while a force upsert still bumps rev', async () => {
        const app = harness.makeApp()
        const repo = app.executionRepository()
        const { workspace } = await app.createWorkspace()

        const base: ExecutionInstance = {
          id: 'exec_cas',
          blockId: 'blk_cas',
          pipelineId: 'pl',
          pipelineName: 'Pipeline',
          steps: [],
          currentStep: 0,
          status: 'running',
          initiatedBy: null,
        }
        // A fresh insert starts at rev 0.
        await repo.upsert(workspace.id, base)
        expect((await repo.get(workspace.id, 'exec_cas'))?.rev).toBe(0)

        // Two writers load the SAME revision (a double-submit / driver-vs-human race).
        const writerA = await repo.get(workspace.id, 'exec_cas')
        const writerB = await repo.get(workspace.id, 'exec_cas')
        expect(writerA?.rev).toBe(0)
        expect(writerB?.rev).toBe(0)

        // The first compareAndSwap lands and bumps the in-memory + stored rev.
        writerA!.status = 'blocked'
        expect(await repo.compareAndSwap(workspace.id, writerA!)).toBe(true)
        expect(writerA!.rev).toBe(1)

        // The second, from the now-stale revision, is refused with NO write.
        writerB!.status = 'done'
        expect(await repo.compareAndSwap(workspace.id, writerB!)).toBe(false)

        // The first writer's state survived; the stale write did not clobber it.
        const afterCas = await repo.get(workspace.id, 'exec_cas')
        expect(afterCas?.status).toBe('blocked')
        expect(afterCas?.rev).toBe(1)

        // The force upsert (the durable driver / lifecycle path) always lands AND keeps rev
        // monotonic, so a later compareAndSwap still detects the row moved.
        afterCas!.status = 'paused'
        await repo.upsert(workspace.id, afterCas!)
        const afterForce = await repo.get(workspace.id, 'exec_cas')
        expect(afterForce?.status).toBe('paused')
        expect(afterForce?.rev).toBe(2)
      })

      // Run diagnostics (dispatch context — backend/model/repo — for after-the-fact
      // investigation) ride in the `detail` JSON, so a repo that serialized `detail`
      // differently would drop them. Asserted at the repository layer so D1 and Postgres
      // are proven to round-trip the whole diagnostics object identically.
      it('round-trips run diagnostics through upsert/get', async () => {
        const app = harness.makeApp()
        const repo = app.executionRepository()
        const { workspace } = await app.createWorkspace()

        const withDiagnostics: ExecutionInstance = {
          id: 'exec_diag',
          blockId: 'blk_diag',
          pipelineId: 'pl',
          pipelineName: 'Pipeline',
          steps: [],
          currentStep: 0,
          status: 'running',
          initiatedBy: null,
          diagnostics: {
            lastDispatch: {
              stepIndex: 2,
              agentKind: 'coder',
              model: 'anthropic:claude-opus-4-8',
              executionBackend: 'local-native',
              repo: { owner: 'acme', name: 'widget', baseBranch: 'main', provider: 'github' },
              at: 1_700_000_000_000,
            },
            host: { platform: 'win32' },
          },
        }
        await repo.upsert(workspace.id, withDiagnostics)

        const loaded = await repo.get(workspace.id, 'exec_diag')
        expect(loaded?.diagnostics).toEqual(withDiagnostics.diagnostics)
      })
    })

    describe('one live execution run per block (insertLive)', () => {
      // Two concurrent starts (double-click, recurring-vs-manual, notification-vs-human retry)
      // must never create two live runs for one block. `insertLive` enforces it atomically via
      // the partial unique index; asserted at the repository layer so D1 and Postgres are proven
      // to reject the second live insert identically.
      it('refuses a second live run for a block until the first goes terminal', async () => {
        const app = harness.makeApp()
        const repo = app.executionRepository()
        const { workspace } = await app.createWorkspace()

        const run = (id: string, status: ExecutionInstance['status']): ExecutionInstance => ({
          id,
          blockId: 'blk_live',
          pipelineId: 'pl',
          pipelineName: 'Pipeline',
          steps: [],
          currentStep: 0,
          status,
          initiatedBy: null,
        })

        // The first live insert lands (and gets a fresh rev).
        const first = run('exec_live_a', 'running')
        expect(await repo.insertLive(workspace.id, first)).toBe(true)
        expect(first.rev).toBe(0)

        // A second live insert for the SAME block — WITHOUT a delete between — is refused with
        // NO write (the concurrent double-start guard). The block keeps exactly the first run.
        expect(await repo.insertLive(workspace.id, run('exec_live_b', 'running'))).toBe(false)
        expect((await repo.getByBlock(workspace.id, 'blk_live'))?.id).toBe('exec_live_a')

        // The index is partial: a `paused`/`blocked` run is still LIVE, so it too blocks a second.
        first.status = 'paused'
        await repo.upsert(workspace.id, first)
        expect(await repo.insertLive(workspace.id, run('exec_live_c', 'running'))).toBe(false)

        // Once the first run reaches a terminal state it leaves the partial index, freeing the
        // block for a fresh live run (the retry-after-failure path). `insertLive` also atomically
        // clears the terminal row in the SAME write, so the block keeps EXACTLY one row (the new
        // live one) — the board's by-block projection never sees a stale terminal alongside it.
        first.status = 'done'
        await repo.upsert(workspace.id, first)
        expect(await repo.insertLive(workspace.id, run('exec_live_d', 'running'))).toBe(true)
        expect((await repo.getByBlock(workspace.id, 'blk_live'))?.id).toBe('exec_live_d')
        // The superseded terminal run was cleaned up in the same transaction.
        expect(await repo.get(workspace.id, 'exec_live_a')).toBeNull()
      })

      it('supersedes the caller’s own prior LIVE run via replaceId (retry/restart)', async () => {
        // `restart` tears its source run down and replaces it while that source is still LIVE
        // (running/paused/blocked). It passes the source id as `replaceId` so `insertLive`
        // removes THAT specific row and inserts the new one atomically — WITHOUT an unconditional
        // delete that would let a concurrent start wipe the winner. Proven on both runtimes.
        const app = harness.makeApp()
        const repo = app.executionRepository()
        const { workspace } = await app.createWorkspace()
        const run = (id: string, status: ExecutionInstance['status']): ExecutionInstance => ({
          id,
          blockId: 'blk_rep',
          pipelineId: 'pl',
          pipelineName: 'Pipeline',
          steps: [],
          currentStep: 0,
          status,
          initiatedBy: null,
        })

        const source = run('exec_src', 'running')
        expect(await repo.insertLive(workspace.id, source)).toBe(true)

        // Without replaceId, a second live insert is refused — the source is still live.
        expect(await repo.insertLive(workspace.id, run('exec_other', 'running'))).toBe(false)
        expect((await repo.getByBlock(workspace.id, 'blk_rep'))?.id).toBe('exec_src')

        // WITH replaceId pointing at the live source, the insert supersedes it and lands.
        expect(
          await repo.insertLive(workspace.id, run('exec_restart', 'running'), {
            replaceId: 'exec_src',
          }),
        ).toBe(true)
        expect((await repo.getByBlock(workspace.id, 'blk_rep'))?.id).toBe('exec_restart')
        expect(await repo.get(workspace.id, 'exec_src')).toBeNull()
      })
    })

    describe('agent_runs sweeper read primitives (listStale + liveRunIds + listPausedExecutions)', () => {
      // The stale-run sweeper reads these `agent_runs` primitives to recover/flag orphaned runs
      // (`listStale` → the re-drive + hard-stall path; `liveRunIds` → the local orphaned-container
      // reap; `listPausedExecutions` → the Node/local budget-freed auto-resume). Assert they behave
      // identically on D1 and Postgres so a facade can't silently drift the recovery path.
      it('listStale carries updatedAt (running only) and liveRunIds filters terminal runs', async () => {
        const app = harness.makeApp()
        const runs = app.agentRunRepository()
        const execs = app.executionRepository()
        const { workspace } = await app.createWorkspace()

        const seed = (id: string, status: ExecutionInstance['status']) =>
          execs.upsert(workspace.id, {
            id,
            blockId: `blk_${id}`,
            pipelineId: 'pl',
            pipelineName: 'Pipeline',
            steps: [],
            currentStep: 0,
            status,
            initiatedBy: null,
          })
        await seed('exec_sweep_running', 'running')
        await seed('exec_sweep_blocked', 'blocked')
        await seed('exec_sweep_paused', 'paused')
        await seed('exec_sweep_done', 'done')
        await seed('exec_sweep_failed', 'failed')

        // `listStale` returns only `running` rows, each carrying a numeric `updatedAt` — the
        // timestamp the sweeper's hard-stall clock reads. (Spans workspaces, so assert by id.)
        const stale = await runs.listStale(Date.now() + 60_000)
        const staleIds = new Set(stale.map((r) => r.id))
        expect(staleIds.has('exec_sweep_running')).toBe(true)
        expect(staleIds.has('exec_sweep_blocked')).toBe(false)
        expect(staleIds.has('exec_sweep_paused')).toBe(false)
        expect(staleIds.has('exec_sweep_done')).toBe(false)
        const runningRow = stale.find((r) => r.id === 'exec_sweep_running')
        expect(typeof runningRow?.updatedAt).toBe('number')
        expect(runningRow?.updatedAt).toBeGreaterThan(0)
        expect(runningRow?.kind).toBe('execution')

        // `liveRunIds` keeps non-terminal runs (running/blocked/paused), drops terminal
        // (done/failed) and unknown ids — the exact contract the container reap depends on.
        const live = new Set(
          await runs.liveRunIds([
            'exec_sweep_running',
            'exec_sweep_blocked',
            'exec_sweep_paused',
            'exec_sweep_done',
            'exec_sweep_failed',
            'exec_sweep_missing',
          ]),
        )
        expect(live.has('exec_sweep_running')).toBe(true)
        expect(live.has('exec_sweep_blocked')).toBe(true)
        expect(live.has('exec_sweep_paused')).toBe(true)
        expect(live.has('exec_sweep_done')).toBe(false)
        expect(live.has('exec_sweep_failed')).toBe(false)
        expect(live.has('exec_sweep_missing')).toBe(false)
        expect(await runs.liveRunIds([])).toEqual([])

        // `listPausedExecutions` returns ONLY the spend-paused execution rows (the Node/local
        // auto-resume candidates) — never running/blocked/terminal ones.
        const pausedIds = new Set((await runs.listPausedExecutions()).map((r) => r.id))
        expect(pausedIds.has('exec_sweep_paused')).toBe(true)
        expect(pausedIds.has('exec_sweep_running')).toBe(false)
        expect(pausedIds.has('exec_sweep_blocked')).toBe(false)
        expect(pausedIds.has('exec_sweep_done')).toBe(false)
        expect(pausedIds.has('exec_sweep_failed')).toBe(false)
      })
    })

    describe('public API (break down an initiative)', () => {
      it('authenticates a public-API key, runs a public inline pipeline headlessly, persists a retrievable result, and hides the anchor block', async () => {
        const { call, createOrgWorkspace, drive } = harness.makeApp()
        // Account-scoped: public-API keys are only minted for an account-owning workspace, so use a
        // seeded ORG workspace (the seed brings the built-in `pl_initiative_breakdown` pipeline).
        const { workspace } = await createOrgWorkspace({ seed: true })
        const wsId = workspace.id

        // Mint an inbound public-API key (needs ENCRYPTION_KEY, which both harnesses configure).
        const created = await call<{ key: { id: string }; secret: string }>(
          'POST',
          `/workspaces/${wsId}/public-api-keys`,
          { label: 'external' },
        )
        expect(created.status).toBe(201)
        const secret = created.body.secret
        expect(secret).toMatch(/^cf_live_/)
        const auth = { authorization: `Bearer ${secret}` }

        // A missing key is refused; a valid key starts the run.
        expect(
          (
            await call('POST', '/api/v1/initiatives', {
              pipelineId: 'pl_initiative_breakdown',
              input: 'x',
            })
          ).status,
        ).toBe(401)
        const started = await call<{ jobId: string; status: string }>(
          'POST',
          '/api/v1/initiatives',
          { pipelineId: 'pl_initiative_breakdown', input: 'Build a cat feeder service' },
          auth,
        )
        expect(started.status).toBe(202)
        const jobId = started.body.jobId

        // Drive the run to completion and read back the DB-persisted result.
        await drive(wsId)
        const job = await call<{ status: string; result: { output: string } | null }>(
          'GET',
          `/api/v1/jobs/${jobId}`,
          undefined,
          auth,
        )
        expect(job.status).toBe(200)
        expect(job.body.status).toBe('succeeded')
        expect(job.body.result?.output).toBeTruthy()

        // The headless anchor block AND its execution are excluded from the board snapshot on both
        // stores — neither the hidden block nor the external run's brief/output reaches the SPA.
        const board = await call<{
          blocks: { title: string; internal?: boolean }[]
          executions: { id: string }[]
        }>('GET', `/workspaces/${wsId}`)
        expect(board.body.blocks.some((b) => b.internal)).toBe(false)
        expect(board.body.blocks.some((b) => b.title === 'Build a cat feeder service')).toBe(false)
        expect(board.body.executions.some((e) => e.id === jobId)).toBe(false)

        // A key can read ONLY the initiative runs it created, never an arbitrary board run in the
        // same workspace: start the SAME public pipeline on a NORMAL seeded task, and the key gets
        // a 404 (its anchor block isn't internal), even though the run exists and shares the scope.
        const normalStart = await call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: 'pl_initiative_breakdown',
        })
        expect(normalStart.status).toBe(201)
        const normalExec = (await drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect((await call('GET', `/api/v1/jobs/${normalExec.id}`, undefined, auth)).status).toBe(
          404,
        )

        // Concurrency backstop (both stores): a workspace may only have 5 initiative runs in
        // flight; leaving them undriven, the 6th start is refused with 429.
        for (let i = 0; i < 5; i++) {
          expect(
            (
              await call(
                'POST',
                '/api/v1/initiatives',
                { pipelineId: 'pl_initiative_breakdown', input: `run ${i}` },
                auth,
              )
            ).status,
          ).toBe(202)
        }
        expect(
          (
            await call(
              'POST',
              '/api/v1/initiatives',
              { pipelineId: 'pl_initiative_breakdown', input: 'overflow' },
              auth,
            )
          ).status,
        ).toBe(429)
        await drive(wsId) // let the in-flight runs finish so none dangle

        // A non-public pipeline id is refused; a revoked key no longer authenticates.
        expect(
          (
            await call(
              'POST',
              '/api/v1/initiatives',
              { pipelineId: 'pl_blueprint', input: 'x' },
              auth,
            )
          ).status,
        ).toBe(400)
        expect(
          (await call('DELETE', `/workspaces/${wsId}/public-api-keys/${created.body.key.id}`))
            .status,
        ).toBe(204)
        expect((await call('GET', `/api/v1/jobs/${jobId}`, undefined, auth)).status).toBe(401)
      })
    })

    describe('pipeline versioning + reseed', () => {
      it('ships catalog versions on the snapshot and reseeds a built-in, preserving organization', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const wsId = workspace.id

        // The snapshot advertises the current built-in catalog versions, keyed by id, so the
        // SPA can flag a stale persisted copy and offer a reseed.
        const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        const expectedVersions = Object.fromEntries(
          seedPipelines().map((p) => [p.id, p.version ?? 0]),
        )
        expect(snap.body.pipelineCatalogVersions).toEqual(expectedVersions)
        // A seeded built-in carries its version, persisted + round-tripped through the store.
        const seededFull = snap.body.pipelines.find((p) => p.id === 'pl_full')!
        expect(seededFull.version).toBe(expectedVersions.pl_full)

        // Organize a built-in (label + archive) — user-owned metadata reseed must preserve.
        await call('PATCH', `/workspaces/${wsId}/pipelines/pl_full/organize`, {
          labels: ['mine'],
          archived: true,
        })

        // Reseed restores the canonical definition + version while keeping labels/archive.
        const seed = seedPipelines().find((p) => p.id === 'pl_full')!
        const reseeded = await call<Pipeline>(
          'POST',
          `/workspaces/${wsId}/pipelines/pl_full/reseed`,
        )
        expect(reseeded.status).toBe(200)
        expect(reseeded.body.agentKinds).toEqual(seed.agentKinds)
        expect(reseeded.body.version).toBe(seed.version)
        expect(reseeded.body.builtin).toBe(true)
        expect(reseeded.body.labels).toEqual(['mine'])
        expect(reseeded.body.archived).toBe(true)

        // It round-trips identically through the store on a fresh read (D1 ⇄ Postgres).
        const after = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        const stored = after.body.pipelines.find((p) => p.id === 'pl_full')!
        expect(stored.labels).toEqual(['mine'])
        expect(stored.archived).toBe(true)
        expect(stored.version).toBe(seed.version)
      })

      it('refuses to reseed a custom pipeline (delete it instead)', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const wsId = workspace.id
        const custom = await call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Custom',
          agentKinds: ['coder'],
        })
        const res = await call('POST', `/workspaces/${wsId}/pipelines/${custom.body.id}/reseed`)
        expect(res.status).toBe(422)
      })

      it('round-trips the per-step companion toggles (followUps + testerQuality) on every store', async () => {
        // The pipeline builder's two per-step companion toggles live on their own JSON columns
        // (D1/Drizzle `follow_ups` + `tester_quality`), so a custom pipeline that opts a Coder
        // step OUT of the Follow-up companion and configures a Tester step's QC companion (an
        // estimate gate) must survive the store round-trip identically — otherwise the builder
        // toggle silently reverts to the default on the next load.
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const wsId = workspace.id

        const created = await call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Toggles',
          agentKinds: ['task-estimator', 'coder', 'tester-api'],
          // Coder opts out of the Follow-up companion; the Tester's QC companion is gated on the
          // task estimate (an estimator runs earlier, so the gate is valid).
          followUps: [null, false, null],
          testerQuality: [
            null,
            null,
            { enabled: true, gating: { enabled: true, minRisk: 0.6, onMissingEstimate: 'run' } },
          ],
        })
        expect(created.status).toBe(201)
        expect(created.body.followUps?.[1]).toBe(false)
        expect(created.body.testerQuality?.[2]).toEqual({
          enabled: true,
          gating: { enabled: true, minRisk: 0.6, onMissingEstimate: 'run' },
        })

        // A fresh snapshot read re-hydrates both columns from the store, identically on D1 ⇄ Postgres.
        const snapshot = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        const stored = snapshot.body.pipelines.find((p) => p.id === created.body.id)!
        expect(stored.followUps?.[1]).toBe(false)
        expect(stored.testerQuality?.[2]).toEqual({
          enabled: true,
          gating: { enabled: true, minRisk: 0.6, onMissingEstimate: 'run' },
        })
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

      it('pushes a real-time board event for human board mutations (add/rename/delete)', async () => {
        // Other users active on a workspace must learn of a board edit live, not only on
        // refresh — so every board mutation emits a coarse `boardChanged`. Asserted on every
        // runtime so a facade can't silently drop the push.
        const { call, createWorkspace, boardEmits } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const wsId = workspace.id

        // Add → emits naming the new block.
        const created = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
          title: 'A collaboratively visible task',
        })
        expect(created.status).toBe(201)
        expect(boardEmits(created.body.id).length).toBeGreaterThan(0)

        // Rename → another event for the same block.
        const before = boardEmits(created.body.id).length
        const renamed = await call('PATCH', `/workspaces/${wsId}/blocks/${created.body.id}`, {
          title: 'Renamed live',
        })
        expect(renamed.status).toBe(200)
        expect(boardEmits(created.body.id).length).toBeGreaterThan(before)

        // Delete → a removal signal reaches the workspace too.
        const removed = await call('DELETE', `/workspaces/${wsId}/blocks/${created.body.id}`)
        expect(removed.status).toBe(204)
        expect(boardEmits().some((e) => e.reason === 'block-removed')).toBe(true)
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

      it('round-trips the per-user (user-tier) budget (D1 ⇄ Postgres)', async () => {
        // The user-tier budget lives in the `user_settings` table (PK user_id). It is user-scoped,
        // so — like local model endpoints — it is exercised through the service directly (the
        // dev-open HTTP `call` path has no signed-in user). Asserts the new table round-trips a
        // nullable numeric identically on both stores.
        const app = harness.makeApp()
        const probe = app.userSettings?.()
        if (!probe) return
        const userId = 'usr_budget_conformance'

        const before = await probe.get(userId)
        expect(before.spendMonthlyLimit).toBeNull()

        const saved = await probe.update(userId, { spendMonthlyLimit: 42 })
        expect(saved.spendMonthlyLimit).toBe(42)
        expect((await probe.get(userId)).spendMonthlyLimit).toBe(42)

        // `0` is a real "no paid spend" limit, distinct from null (inherit/unlimited).
        await probe.update(userId, { spendMonthlyLimit: 0 })
        expect((await probe.get(userId)).spendMonthlyLimit).toBe(0)

        await probe.update(userId, { spendMonthlyLimit: null })
        expect((await probe.get(userId)).spendMonthlyLimit).toBeNull()
      })

      it('round-trips the local-mode delegation toggle + a paired boolean (D1 ⇄ Postgres)', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const wsId = workspace.id

        type Settings = {
          delegateAgentsToRunnerPool: boolean
          kaizenEnabled: boolean
        }
        // Fresh-workspace defaults: agent delegation off (local-everything), Kaizen on.
        const initial = await call<Settings>('GET', `/workspaces/${wsId}/settings`)
        expect(initial.status).toBe(200)
        expect(initial.body.delegateAgentsToRunnerPool).toBe(false)
        expect(initial.body.kaizenEnabled).toBe(true)

        // Both flip and persist identically through the workspace_settings columns.
        const put = await call<Settings>('PUT', `/workspaces/${wsId}/settings`, {
          delegateAgentsToRunnerPool: true,
          kaizenEnabled: false,
        })
        expect(put.status).toBe(200)
        expect(put.body.delegateAgentsToRunnerPool).toBe(true)
        expect(put.body.kaizenEnabled).toBe(false)

        const reread = await call<Settings>('GET', `/workspaces/${wsId}/settings`)
        expect(reread.body.delegateAgentsToRunnerPool).toBe(true)
        expect(reread.body.kaizenEnabled).toBe(false)

        // A partial patch leaves the untouched flag intact (per-field merge).
        const partial = await call<Settings>('PUT', `/workspaces/${wsId}/settings`, {
          delegateAgentsToRunnerPool: false,
        })
        expect(partial.body.delegateAgentsToRunnerPool).toBe(false)
        expect(partial.body.kaizenEnabled).toBe(false)
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

      it('round-trips a service frame provisioning config (the JSON column) on every store', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const wsId = workspace.id

        // The service-owned provisioning config (the "what + where") is a JSON object on the
        // service frame. A runtime that forgot to map the `provisioning` column drops it on
        // write — so this asserts it survives PATCH + a fresh snapshot read on D1 and Postgres.
        const provisioning = {
          type: 'docker-compose' as const,
          composePath: 'docker-compose.yml',
          localDevOnly: true,
        }
        const patched = await call<Block>('PATCH', `/workspaces/${wsId}/blocks/blk_auth`, {
          provisioning,
        })
        expect(patched.status).toBe(200)
        expect(patched.body.provisioning).toEqual(provisioning)

        const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        expect(snap.body.blocks.find((b) => b.id === 'blk_auth')?.provisioning).toEqual(
          provisioning,
        )
      })

      it('round-trips a frontend frame config (the JSON column + backend bindings) on every store', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const wsId = workspace.id

        // A frontend frame's `frontendConfig` (build/serve/mock knobs + the backend bindings
        // that double as board links) is a JSON object on the frame block, mirroring
        // `provisioning`. A runtime that forgot to map the `frontend_config` column drops it on
        // write — so this asserts it survives PATCH + a fresh snapshot read on D1 and Postgres.
        const frontendConfig = {
          packageManager: 'pnpm' as const,
          buildScript: 'build',
          outputDir: 'dist',
          serveMode: 'static' as const,
          servePort: 8080,
          envInjection: 'build' as const,
          mockMappingsPath: 'mocks/',
          previewEnabled: true,
          backendBindings: [
            {
              envVar: 'PUB_BACKEND_URL',
              source: { kind: 'service' as const, serviceBlockId: 'blk_auth' },
            },
            { envVar: 'PUB_OTHER_URL', source: { kind: 'mock' as const } },
          ],
        }
        const patched = await call<Block>('PATCH', `/workspaces/${wsId}/blocks/blk_auth`, {
          frontendConfig,
        })
        expect(patched.status).toBe(200)
        expect(patched.body.frontendConfig).toEqual(frontendConfig)

        const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        expect(snap.body.blocks.find((b) => b.id === 'blk_auth')?.frontendConfig).toEqual(
          frontendConfig,
        )
      })

      it('round-trips service connections + involved services (the JSON columns) on every store', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const wsId = workspace.id

        // A service frame's `serviceConnections` (consumer→provider edges) and a task's
        // `involvedServiceIds` are JSON columns on the block, mirroring `frontend_config`.
        // A runtime that forgot to map either column drops it on write — so this asserts
        // both survive PATCH + a fresh snapshot read on D1 and Postgres. The seed has one
        // service-type frame (blk_auth), so create the provider frame to connect to.
        const provider = await call<Block>('POST', `/workspaces/${wsId}/blocks`, {
          type: 'service',
          position: { x: 900, y: 900 },
        })
        const providerId = provider.body.id
        expect(providerId).toBeTruthy()

        const serviceConnections = [
          { serviceBlockId: providerId, description: 'sends transactional email via it' },
        ]
        const patched = await call<Block>('PATCH', `/workspaces/${wsId}/blocks/blk_auth`, {
          serviceConnections,
        })
        expect(patched.status).toBe(200)
        expect(patched.body.serviceConnections).toEqual(serviceConnections)

        // The task may involve a connected neighbor (either direction); its own frame never.
        const task = await call<Block>('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
          involvedServiceIds: [providerId],
        })
        expect(task.status).toBe(200)
        expect(task.body.involvedServiceIds).toEqual([providerId])

        const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        expect(snap.body.blocks.find((b) => b.id === 'blk_auth')?.serviceConnections).toEqual(
          serviceConnections,
        )
        expect(snap.body.blocks.find((b) => b.id === 'task_login')?.involvedServiceIds).toEqual([
          providerId,
        ])

        // Write-gate guards: a self-connection and an unconnected involved service are
        // ValidationErrors (422 per the shared error handler).
        const selfConn = await call('PATCH', `/workspaces/${wsId}/blocks/blk_auth`, {
          serviceConnections: [{ serviceBlockId: 'blk_auth' }],
        })
        expect(selfConn.status).toBe(422)
        const unconnected = await call('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
          involvedServiceIds: ['blk_db'],
        })
        expect(unconnected.status).toBe(422)
      })

      it("round-trips a task's read-only reference repos (the JSON column) on every store", async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const wsId = workspace.id

        // `referenceRepos` is a DOCUMENT-task-only JSON column carrying the doc-writer agent's
        // read-only reference repos, each a self-contained clone identity (NOT resolved from
        // the repo projection). BoardService.update drops it on any non-document block, so the
        // round-trip is asserted on a real document task: a runtime that forgot to map the
        // column drops it on write, so this checks it survives PATCH + a fresh snapshot read,
        // and that clearing writes NULL (an empty array comes back absent), on D1 and Postgres.
        const doc = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
          title: 'Author the API guide',
          taskType: 'document',
        })
        expect(doc.status).toBe(201)
        const docId = doc.body.id

        const referenceRepos = [
          { repoId: 111, owner: 'acme', name: 'design-system', defaultBranch: 'main' },
          {
            repoId: 222,
            owner: 'acme',
            name: 'api-conventions',
            defaultBranch: 'trunk',
            connectionId: 42,
          },
        ]
        const set = await call<Block>('PATCH', `/workspaces/${wsId}/blocks/${docId}`, {
          referenceRepos,
        })
        expect(set.status).toBe(200)
        expect(set.body.referenceRepos).toEqual(referenceRepos)

        const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        expect(snap.body.blocks.find((b) => b.id === docId)?.referenceRepos).toEqual(referenceRepos)

        // Clearing with an empty array writes NULL, so the field comes back absent (mirroring
        // the other JSON-array block columns' empty-is-null convention).
        const cleared = await call<Block>('PATCH', `/workspaces/${wsId}/blocks/${docId}`, {
          referenceRepos: [],
        })
        expect(cleared.status).toBe(200)
        expect(cleared.body.referenceRepos).toBeUndefined()
      })

      it("records a multi-repo run's peer pull requests on the block (both stores)", async () => {
        // Service-connections phase 3: a coder run over a task with a connected involved service
        // opens a PR in the peer's repo too. The container reports it as `peerPullRequests`
        // beside the own-service PR; the engine records BOTH on the block. This asserts the
        // full recording + JSON-column round-trip on D1 and Postgres (the fake stands in for
        // the container — the resolveRepoTargets/peerRepos dispatch path is unit-tested in the
        // server package). `allPullRequests` then sees the own PR first, then the peer.
        const app = harness.makeApp({
          asyncKinds: ['coder'],
          asyncPolls: 1,
          pullRequest: {
            url: 'https://gh/acme/auth/pull/1',
            number: 1,
            branch: 'cat-factory/task_login',
          },
          peerPullRequests: [
            {
              repo: 'acme/email',
              frameId: 'blk_email',
              ref: {
                url: 'https://gh/acme/email/pull/7',
                number: 7,
                branch: 'cat-factory/task_login',
              },
            },
          ],
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        // Connect blk_auth → a provider frame and mark it involved in the task (realistic setup;
        // the recording itself is driven by what the fake reports, not the resolution).
        const provider = await app.call<Block>('POST', `/workspaces/${wsId}/blocks`, {
          type: 'service',
          position: { x: 900, y: 900 },
        })
        await app.call('PATCH', `/workspaces/${wsId}/blocks/blk_auth`, {
          serviceConnections: [
            { serviceBlockId: provider.body.id, description: 'sends mail via it' },
          ],
        })
        await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
          involvedServiceIds: [provider.body.id],
        })

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Implement',
          agentKinds: ['coder'],
        })
        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)
        await app.drive(wsId)

        const snap = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        const task = snap.body.blocks.find((b) => b.id === 'task_login')!
        expect(task.pullRequest?.url).toBe('https://gh/acme/auth/pull/1')
        expect(task.peerPullRequests).toEqual([
          {
            repo: 'acme/email',
            frameId: 'blk_email',
            ref: {
              url: 'https://gh/acme/email/pull/7',
              number: 7,
              branch: 'cat-factory/task_login',
            },
          },
        ])
        expect(allPullRequests(task)).toEqual([
          { ref: task.pullRequest },
          { repo: 'acme/email', frameId: 'blk_email', ref: task.peerPullRequests![0]!.ref },
        ])
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

      it('findByIds resolves blocks across workspaces in one batched read', async () => {
        // The cross-workspace dependency gate resolves a dependent's foreign blockers via
        // the batched `BlockRepository.findByIds` (never a point-read per id) — assert the
        // batched read maps each block to its HOME workspace identically on every store.
        const app = harness.makeApp()
        const { workspace: wsA } = await app.createWorkspace()
        const { workspace: wsB } = await app.createWorkspace()
        const a = await app.call<Block>('POST', `/workspaces/${wsA.id}/blocks/blk_auth/tasks`, {
          title: 'Home task',
        })
        const b = await app.call<Block>('POST', `/workspaces/${wsB.id}/blocks/blk_auth/tasks`, {
          title: 'Foreign task',
        })
        const repo = app.blockRepository()
        const found = await repo.findByIds([a.body.id, b.body.id, 'blk_does_not_exist'])
        // Both blocks resolve with their home workspace; the unknown id is simply absent.
        expect(found).toHaveLength(2)
        const byId = new Map(found.map((f) => [f.block.id, f]))
        expect(byId.get(a.body.id)?.workspaceId).toBe(wsA.id)
        expect(byId.get(b.body.id)?.workspaceId).toBe(wsB.id)
        expect(byId.get(a.body.id)?.block.title).toBe('Home task')
        // Empty input short-circuits to an empty result.
        expect(await repo.findByIds([])).toEqual([])
      })
    })

    describe('notifications', () => {
      it('escalateStaleOpen flips exactly the overdue open normal cards in one statement', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const repo = app.notificationRepository()
        const card = (id: string, overrides: Partial<Notification>): Notification =>
          ({
            id,
            type: 'merge_review',
            status: 'open',
            severity: 'normal',
            blockId: null,
            executionId: null,
            title: id,
            body: 'body',
            payload: null,
            createdAt: 1_000,
            resolvedAt: null,
            ...overrides,
          }) as Notification
        await repo.upsert(wsId, card('ntf_overdue', {}))
        await repo.upsert(wsId, card('ntf_recent', { createdAt: 50_000 }))
        await repo.upsert(wsId, card('ntf_already_urgent', { severity: 'urgent' }))
        await repo.upsert(wsId, card('ntf_dismissed', { status: 'dismissed', resolvedAt: 2_000 }))

        // Only the open, still-normal card past the cutoff flips — and is returned for
        // re-delivery (the real-time inbox re-render).
        const escalated = await repo.escalateStaleOpen(wsId, 10_000)
        expect(escalated.map((n) => n.id)).toEqual(['ntf_overdue'])
        expect(escalated[0]?.severity).toBe('urgent')

        const open = await repo.listOpen(wsId)
        const severityById = new Map(open.map((n) => [n.id, n.severity]))
        expect(severityById.get('ntf_overdue')).toBe('urgent')
        expect(severityById.get('ntf_recent')).toBe('normal')
        expect(severityById.get('ntf_already_urgent')).toBe('urgent')
        // Idempotent: a second sweep finds nothing left to flip.
        expect(await repo.escalateStaleOpen(wsId, 10_000)).toEqual([])
      })
    })

    describe('model presets', () => {
      it('seeds the built-ins, CRUDs presets and surfaces them on the snapshot', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()

        // A fresh workspace is lazily seeded with the built-in catalog: Kimi K2.7 (the
        // Cloudflare-runnable default in the conformance harnesses, everything Kimi), GLM-5.2,
        // and Claude Opus 4.8. Each built-in carries its catalog version.
        const initial = await call<ModelPreset[]>(
          'GET',
          `/workspaces/${workspace.id}/model-presets`,
        )
        expect(initial.status).toBe(200)
        const seeded = initial.body
        expect(seeded.length).toBeGreaterThanOrEqual(3)
        const def = seeded.find((p) => p.isDefault)
        expect(def?.baseModelId).toBe('kimi-k2.7')
        expect(def?.version).toBe(1)
        expect(seeded.some((p) => p.baseModelId === 'glm')).toBe(true)
        // The Claude-only built-in ships in the catalog (default only in local mode; here it's
        // present but non-default since the conformance harnesses seed with Kimi as the default).
        const claude = seeded.find((p) => p.id === 'mdp_claude')
        expect(claude?.baseModelId).toBe('claude-opus')
        expect(claude?.isDefault).toBe(false)

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

      it('ships catalog versions on the snapshot and reseeds a built-in (drift repair + new appeared)', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const wsId = workspace.id
        const base = `/workspaces/${wsId}/model-presets`

        // The snapshot ships the built-in catalog versions so the SPA can offer a reseed.
        const snap = await call<{ modelPresetCatalogVersions?: Record<string, number> }>(
          'GET',
          `/workspaces/${wsId}`,
        )
        expect(snap.body.modelPresetCatalogVersions).toMatchObject({
          mdp_kimi: 1,
          mdp_glm: 1,
          mdp_claude: 1,
        })

        // Seed, then drift a built-in (rename + change its base model). Reseed must restore the
        // canonical definition + version while preserving the user's default + ordering.
        await call('GET', base)
        await call('PATCH', `${base}/mdp_kimi`, { name: 'Tampered', baseModelId: 'glm' })
        const reseeded = await call<ModelPreset>('POST', `${base}/mdp_kimi/reseed`)
        expect(reseeded.status).toBe(200)
        expect(reseeded.body.name).toBe('Kimi K2.7')
        expect(reseeded.body.baseModelId).toBe('kimi-k2.7')
        expect(reseeded.body.version).toBe(1)
        // The default is preserved across a reseed (the conformance harnesses default to Kimi).
        expect(reseeded.body.isDefault).toBe(true)

        // Reseeding a NEW built-in the workspace doesn't have yet materialises it (the
        // "appeared upstream" case): delete the claude preset, then reseed it back.
        await call('DELETE', `${base}/mdp_claude`)
        const afterDelete = await call<ModelPreset[]>('GET', base)
        expect(afterDelete.body.some((p) => p.id === 'mdp_claude')).toBe(false)
        const readded = await call<ModelPreset>('POST', `${base}/mdp_claude/reseed`)
        expect(readded.status).toBe(200)
        expect(readded.body.baseModelId).toBe('claude-opus')
        // Re-materialising a non-default built-in must not steal the default from Kimi.
        expect(readded.body.isDefault).toBe(false)

        // A custom (non-catalog) preset cannot be reseeded — delete it instead.
        const custom = await call<ModelPreset>('POST', base, { name: 'Custom', baseModelId: 'glm' })
        const badReseed = await call('POST', `${base}/${custom.body.id}/reseed`)
        expect(badReseed.status).toBe(422)
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
            agentKinds: ['coder', 'documenter', 'doc-outliner'],
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

          // The doc-outliner is `doc-aware`: it folds the same service fragments (the
          // document writing-style path is the doc analogue of code-aware).
          const outliner = exec.steps.find((s) => s.agentKind === 'doc-outliner')!
          expect(outliner.output).toContain('[frags]test.svc-standard[/frags]')
          expect(outliner.selectedFragmentIds).toEqual(['test.svc-standard'])

          // The documenter is neither code-aware, doc-aware nor spec-aware: no fragments.
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

      it('resolves the built-in design.context fragment into a code-aware run', async () => {
        // The shared design-context fragment (the one a linked Figma/Zeplin document's
        // materialised `.cat-context/*.md` pairs with) is a built-in catalog entry. Pinning
        // it on a service and asserting a `coder` run resolves it proves the fragment is in
        // the universal pool and reaches a code-aware agent identically on D1 and Postgres —
        // a rename/removal of the design fragment fails here. (The document body's own
        // materialisation into the agent context is covered by the generic document-source
        // path; design sources ride it unchanged.)
        const app = harness.makeApp({ echoFragments: true })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        await app.call('PATCH', `/workspaces/${wsId}/blocks/blk_auth`, {
          serviceFragmentIds: ['design.context'],
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
        expect(coder.selectedFragmentIds).toEqual(['design.context'])
        expect(coder.output).toContain('[frags]design.context[/frags]')
      })
    })

    describe('registered custom kind pre/post-ops', () => {
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

        // App-owned DI: a deployment news a registry (pre-loaded with the built-ins) and
        // registers its kind on it BY REFERENCE, then injects the SAME instance into the
        // container build — no module-global, no `clear*()`. The suite threads it through
        // `makeApp`'s `agentKindRegistry` option (into both the container and the fake).
        const agentKindRegistry = defaultAgentKindRegistry()
        agentKindRegistry.register({
          kind: 'conformance-auditor',
          systemPrompt: 'You audit the service for compliance.',
          // A read-only container-explore step returning structured JSON (surfaced as
          // `result.custom`) — exactly the generic manifest-driven `agent` dispatch.
          agent: { surface: 'container-explore', output: { kind: 'structured' } },
          // Presentation makes it a first-class palette block, so the workspace snapshot's
          // custom-kind projection advertises it (the snapshot assertion below).
          presentation: {
            label: 'Conformance Auditor',
            icon: 'i-lucide-shield-check',
            color: '#10b981',
            description: 'Audits the service for compliance.',
            category: 'review',
            resultView: 'generic-structured',
          },
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
          { resolveRunRepoContext: async () => ({ repo, baseBranch: 'main' }), agentKindRegistry },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        // The registered kind is advertised in the workspace snapshot's custom-kind palette on
        // every runtime — proving the injected instance reaches the HTTP snapshot projection,
        // not just the engine (the module-global registration this replaces used to do this).
        const snap = await app.call<{ customAgentKinds?: { kind: string }[] }>(
          'GET',
          `/workspaces/${wsId}`,
        )
        expect(
          (snap.body.customAgentKinds ?? []).some((k) => k.kind === 'conformance-auditor'),
        ).toBe(true)

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
        // The built-in gates (ci / conflicts / post-release-health) live in the SAME registry
        // as the test's `license-check` gate, so clearing wipes them too — restore them so
        // later assertions (and a real harness build) still see the platform's own gates.
        registerBuiltinGates()
        // NOTE: the agent-kind registry is now app-owned (per-test instance injected via
        // `makeApp({ agentKindRegistry })`), so there is nothing global to clear here.
      })

      // A deployment-registered polling gate is the OTHER half of the extension story
      // (alongside custom agent kinds): a deterministic precheck that passes through when
      // clean and only escalates to a registered helper agent on a red verdict. The engine
      // merges it into the (otherwise built-in) gate registry and drives it through the SAME
      // generic gate machine — so a facade that forgot to wire the registry merge, or one
      // whose gate state machine drifts, fails here rather than shipping. Mirrors the
      // built-in `ci`→`ci-fixer` gate, with the provider faked in-test (no real GitHub).

      // The custom gate's helper is just a registered agent kind — no new dispatch path.
      // Registered on a per-test app-owned registry (injected via makeApp), not a global.
      const registerLicenseFixer = (registry: ReturnType<typeof defaultAgentKindRegistry>): void =>
        registry.register({
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
        const agentKindRegistry = defaultAgentKindRegistry()
        registerLicenseFixer(agentKindRegistry)
        registerLicenseGate([true]) // clean on first probe
        const app = harness.makeApp(
          { asyncKinds: ['coder', 'license-fixer'] },
          { agentKindRegistry },
        )
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
        const agentKindRegistry = defaultAgentKindRegistry()
        registerLicenseFixer(agentKindRegistry)
        registerLicenseGate([false, true]) // red first, clean after the fixer ran
        const app = harness.makeApp(
          {
            asyncKinds: ['coder', 'license-fixer'],
            pullRequest: { url: 'https://github.com/o/r/pull/1', number: 1, branch: 'feat/login' },
          },
          { agentKindRegistry },
        )
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
        const agentKindRegistry = defaultAgentKindRegistry()
        agentKindRegistry.register({
          kind: 'conformance-auditor',
          systemPrompt: 'You audit.',
          agent: { surface: 'container-explore', output: { kind: 'structured' } },
        })
        registerStepResolver('conformance-auditor', () => ({
          kind: 'conformance-auditor',
          applies: (result) => result.custom !== undefined,
          resolve: async () => ({ output: 'resolver-rewrote-this' }),
        }))
        const app = harness.makeApp({ customResult: { ok: true } }, { agentKindRegistry })
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
              repos: [
                {
                  repo: 'o/r',
                  headSha: 'sha',
                  checks: [
                    {
                      name: 'build',
                      status: 'completed',
                      conclusion: green ? 'success' : 'failure',
                      url: null,
                    },
                  ],
                },
              ],
            }
          },
        }
      }

      // A multi-repo (service-connections phase 4) fake CI provider: the task opened an
      // own-service PR AND one peer PR, and the gate aggregates the verdict across BOTH. Each
      // repo's greenness is supplied per probe (a queue; last entry repeats) so a test can drive
      // "peer red → own green" then "both green".
      const makeFakeMultiRepoCi = (rounds: [boolean, boolean][]): CiStatusProvider => {
        let i = 0
        return {
          getStatus: async () => {
            const [ownGreen, peerGreen] = rounds[Math.min(i, rounds.length - 1)] ?? [true, true]
            i += 1
            const checks = (green: boolean, name: string) => [
              { name, status: 'completed', conclusion: green ? 'success' : 'failure', url: null },
            ]
            return {
              repos: [
                { repo: 'o/own', headSha: 'ownsha', checks: checks(ownGreen, 'own-build') },
                { repo: 'o/peer', headSha: 'peersha', checks: checks(peerGreen, 'peer-build') },
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
            // Model a container-reusing runner: the gate's `ci-fixer` helper shares the
            // re-dispatch shape the per-round dispatch epoch fixes, so exercise it under a
            // pooled harness whose JobRegistry survives between rounds.
            pooledContainer: true,
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
        const attempt = step.gate?.attemptLog?.[0]
        expect(attempt?.outcome).toBe('completed')
        // The round records WHAT it was handed to fix (the failing-check summary + the
        // structured red checks), not only that a round happened — the gate analogue of the
        // Tester attempt's concerns, surfaced per-runtime.
        expect(attempt?.instructions).toBeTruthy()
        expect(attempt?.failingChecks?.map((c) => c.name)).toEqual(['build'])
      })

      it('aggregates CI across a multi-repo task: a red PEER PR escalates, both green advances', async () => {
        // Service-connections phase 4: a cross-service task opens one PR per changed repo, and the
        // CI gate aggregates the verdict across ALL of them. Here the OWN PR is green but a PEER
        // PR is red on the first probe → the gate must NOT advance (a red peer fails the gate),
        // escalate the ci-fixer once, then advance when the re-probe sees both green. The per-repo
        // head shas are persisted on the gate state so the UI can group checks by service.
        const app = harness.makeApp(
          {
            asyncKinds: ['coder', 'ci-fixer'],
            pooledContainer: true,
            pullRequest: {
              url: 'https://github.com/o/own/pull/1',
              number: 1,
              branch: 'feat/login',
            },
          },
          // round 1: own green, peer RED → fail+escalate; round 2: both green → advance
          {
            gateProviders: {
              ciStatus: makeFakeMultiRepoCi([
                [true, false],
                [true, true],
              ]),
            },
          },
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
        // The red PEER PR fails the aggregate verdict → one ci-fixer attempt.
        expect(step.gate?.attempts).toBe(1)
        // Both repos' heads are tracked on the multi-repo gate state.
        expect(step.gate?.headShas).toMatchObject({ 'o/own': 'ownsha', 'o/peer': 'peersha' })
        // The failing round names the failing peer check (with its repo).
        const failing = step.gate?.attemptLog?.[0]?.failingChecks ?? []
        expect(failing.map((c) => c.name)).toContain('peer-build')
        expect(failing.find((c) => c.name === 'peer-build')?.repo).toBe('o/peer')
      })
    })

    describe('built-in doc-quality gate (externalized to @cat-factory/gates)', () => {
      // The forward document pipelines' structural gate: a deterministic precheck of the drafted
      // document that passes through when well-formed and escalates to the registered `doc-fixer`
      // helper on a red verdict. Driving it over a faked DocQualityProvider proves the externalized
      // gate + its wire-handle + each facade's import + the doc-fixer registered helper behave
      // identically on every runtime — a drift fails here instead of shipping.
      afterEach(() => clearGateProviders())

      // A fake doc-quality provider whose verdict is supplied per-probe (a queue; last repeats).
      const makeFakeDocQuality = (oks: boolean[]): DocQualityProvider => {
        let i = 0
        return {
          check: async () => {
            const ok = oks[Math.min(i, oks.length - 1)] ?? true
            i += 1
            return ok
              ? { ok: true, headSha: 'sha', path: 'docs/prd/x.md', findings: [] }
              : {
                  ok: false,
                  headSha: 'sha',
                  path: 'docs/prd/x.md',
                  findings: ['Missing required section: "Success Metrics".'],
                }
          },
        }
      }

      it('passes through on a well-formed document without spinning up doc-fixer', async () => {
        const app = harness.makeApp(
          { asyncKinds: ['coder', 'doc-fixer'] },
          { gateProviders: { docQuality: makeFakeDocQuality([true]) } },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Doc + quality',
          agentKinds: ['coder', 'doc-quality'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        const step = exec.steps.find((s) => s.agentKind === 'doc-quality')!
        expect(step.state).toBe('done')
        expect(step.gate?.attempts ?? 0).toBe(0)
        expect(step.output).toContain('Document-quality gate passed')
      })

      it('escalates to doc-fixer on a malformed document, then advances when it re-probes clean', async () => {
        const app = harness.makeApp(
          {
            asyncKinds: ['coder', 'doc-fixer'],
            pooledContainer: true,
            pullRequest: { url: 'https://github.com/o/r/pull/1', number: 1, branch: 'feat/doc' },
          },
          // malformed first, well-formed after the doc-fixer ran
          { gateProviders: { docQuality: makeFakeDocQuality([false, true]) } },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Doc + quality',
          agentKinds: ['coder', 'doc-quality'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        const step = exec.steps.find((s) => s.agentKind === 'doc-quality')!
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
        // The gate only resolves a fixer round's threads once the fixer actually pushed a commit
        // (the PR head advanced). Model that: the head is `sha1` on the dispatch probe and
        // advances to `sha2` afterwards, so onHelperComplete confirms progress and resolves.
        let reviews = 0
        const provider: PullRequestReviewProvider = {
          getReview: async () => {
            reviews += 1
            const headSha = reviews >= 2 ? 'sha2' : 'sha'
            return resolved
              ? { ...APPROVED_CLEAN, headSha }
              : {
                  ...APPROVED_CLEAN,
                  headSha,
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
                }
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

      it('runs the SAME provider guard on RETRY as on start (refuses a retry gone unsatisfiable)', async () => {
        // A retry re-drives the failed run through the same steps, so it must be gated exactly
        // like a start — otherwise a run that failed under a now-unconfigured model silently
        // re-dispatches and fails again mid-run (the drift that let a subscription-only preset
        // slip past retry). Start under a configured model, fail it, remove the provider, retry →
        // refused up front with the same conflict a fresh start gives.
        const { call, createWorkspace, drive } = harness.makeApp(
          { asyncKinds: ['coder'], dispatchThrowKinds: ['coder'] },
          { cloudflareModelsEnabled: false },
        )
        const { workspace } = await createWorkspace()
        const wsId = workspace.id

        // Configure a qwen key + pin qwen so the start guard passes, then fail the run.
        const key = await call<{ id: string }>('POST', `/workspaces/${wsId}/api-keys`, KEY)
        await call('PATCH', `/workspaces/${wsId}/blocks/task_login`, { modelId: 'qwen' })
        const pipeline = await call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build only',
          agentKinds: ['coder'],
        })
        const start = await call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)
        const exec = (await drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('failed')

        // Remove the provider key → the pinned model is no longer usable for THIS workspace.
        const removed = await call('DELETE', `/workspaces/${wsId}/api-keys/${key.body.id}`)
        expect(removed.status).toBe(204)

        // Retry the failed run → refused with the same providers_unconfigured conflict as a start,
        // because retry now shares start's `assertRunnable` gate.
        const retried = await call<{ error: { details?: { reason?: string } } }>(
          'POST',
          `/workspaces/${wsId}/agent-runs/${exec.id}/retry`,
        )
        expect(retried.status).toBe(409)
        expect(retried.body.error.details?.reason).toBe('providers_unconfigured')
      })

      it('runs the SAME provider guard on RESTART-from-step as on start', async () => {
        // A restart re-dispatches the stored steps just like a retry (from an arbitrary step),
        // so it must be gated identically — otherwise a run whose model went unconfigured slips
        // past restart and strands mid-run. Start under a configured model, fail it, remove the
        // provider, restart from step 0 → refused up front with the same conflict a start gives.
        const { call, createWorkspace, drive } = harness.makeApp(
          { asyncKinds: ['coder'], dispatchThrowKinds: ['coder'] },
          { cloudflareModelsEnabled: false },
        )
        const { workspace } = await createWorkspace()
        const wsId = workspace.id

        const key = await call<{ id: string }>('POST', `/workspaces/${wsId}/api-keys`, KEY)
        await call('PATCH', `/workspaces/${wsId}/blocks/task_login`, { modelId: 'qwen' })
        const pipeline = await call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build only',
          agentKinds: ['coder'],
        })
        const start = await call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: pipeline.body.id },
        )
        expect(start.status).toBe(201)
        const exec = (await drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('failed')

        const removed = await call('DELETE', `/workspaces/${wsId}/api-keys/${key.body.id}`)
        expect(removed.status).toBe(204)

        // Restart from the first step → refused with providers_unconfigured, because restart now
        // shares start's `assertRunnable` gate over the stored steps it re-drives.
        const restarted = await call<{ error: { details?: { reason?: string } } }>(
          'POST',
          `/workspaces/${wsId}/executions/${exec.id}/restart`,
          { fromStepIndex: 0 },
        )
        expect(restarted.status).toBe(409)
        expect(restarted.body.error.details?.reason).toBe('providers_unconfigured')
      })
    })

    describe('merge presets', () => {
      it('seeds the built-in catalog, enforces the single-default invariant, and guards the default', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/merge-presets`

        // First list lazily seeds the whole built-in catalog: Balanced (default, auto-merge on)
        // and "Manual review only" (non-default, auto-merge OFF).
        const initial = await call<MergeThresholdPreset[]>('GET', base)
        expect(initial.status).toBe(200)
        expect(initial.body).toHaveLength(2)
        const balanced = initial.body.find((p) => p.id === 'mp_balanced')!
        const manual = initial.body.find((p) => p.id === 'mp_manual_review')!
        expect(balanced.isDefault).toBe(true)
        expect(balanced.autoMergeEnabled).toBe(true)
        expect(balanced.version).toBe(2)
        // The QC-companion budget round-trips with its default through both stores.
        expect(balanced.maxTesterQualityIterations).toBe(3)
        // "Manual review only" fully prevents auto-merge: every PR is routed to human review.
        expect(manual.isDefault).toBe(false)
        expect(manual.autoMergeEnabled).toBe(false)
        // The post-release-health knobs round-trip with their defaults through both stores.
        expect(balanced.releaseWatchWindowMinutes).toBe(30)
        expect(balanced.releaseMaxAttempts).toBe(1)
        const seededDefaultId = balanced.id

        // Add a non-default preset; the seeded default stays the default.
        const lenient = await call<MergeThresholdPreset>('POST', base, {
          name: 'Lenient',
          maxComplexity: 0.9,
          maxRisk: 0.8,
          maxImpact: 0.7,
          ciMaxAttempts: 5,
          maxRequirementIterations: 5,
          maxRequirementConcernAllowed: 'medium',
          maxTesterQualityIterations: 4,
          releaseWatchWindowMinutes: 45,
          releaseMaxAttempts: 2,
        })
        expect(lenient.status).toBe(201)
        expect(lenient.body.isDefault).toBe(false)
        // The requirements-loop + QC + release-health fields round-trip through the store on both runtimes.
        expect(lenient.body.maxRequirementIterations).toBe(5)
        expect(lenient.body.maxRequirementConcernAllowed).toBe('medium')
        expect(lenient.body.maxTesterQualityIterations).toBe(4)
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
        // Two seeded built-ins + Lenient + Strict.
        expect(afterPromote.body).toHaveLength(4)
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
        expect(final.body.map((p) => p.id).sort()).toEqual(
          [seededDefaultId, 'mp_manual_review', strict.body.id].sort(),
        )
      })

      it('ships catalog versions on the snapshot and reseeds a built-in (drift repair + new appeared)', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const wsId = workspace.id
        const base = `/workspaces/${wsId}/merge-presets`

        // The snapshot ships the built-in catalog versions so the SPA can offer a reseed.
        const snap = await call<{ mergePresetCatalogVersions?: Record<string, number> }>(
          'GET',
          `/workspaces/${wsId}`,
        )
        expect(snap.body.mergePresetCatalogVersions).toMatchObject({
          mp_balanced: 2,
          mp_manual_review: 2,
        })

        // Seed, then drift a built-in (turn its auto-merge OFF + rename). Reseed must restore the
        // canonical definition + version while preserving the user's default + ordering.
        await call('GET', base)
        await call('PATCH', `${base}/mp_balanced`, {
          name: 'Tampered',
          autoMergeEnabled: false,
        })
        const reseeded = await call<MergeThresholdPreset>('POST', `${base}/mp_balanced/reseed`)
        expect(reseeded.status).toBe(200)
        expect(reseeded.body.name).toBe('Balanced')
        expect(reseeded.body.autoMergeEnabled).toBe(true)
        expect(reseeded.body.version).toBe(2)
        // The default is preserved across a reseed.
        expect(reseeded.body.isDefault).toBe(true)

        // Reseeding a NEW built-in the workspace doesn't have yet materialises it (the
        // "appeared upstream" case): delete the manual preset, then reseed it back.
        await call('DELETE', `${base}/mp_manual_review`)
        const afterDelete = await call<MergeThresholdPreset[]>('GET', base)
        expect(afterDelete.body.some((p) => p.id === 'mp_manual_review')).toBe(false)
        const readded = await call<MergeThresholdPreset>('POST', `${base}/mp_manual_review/reseed`)
        expect(readded.status).toBe(200)
        expect(readded.body.autoMergeEnabled).toBe(false)

        // Re-materialising a default-flagged built-in must NOT steal the default: promote a
        // custom preset to default, delete the (now non-default) mp_balanced, then reseed it.
        // mp_balanced's seed is default-flagged, but the workspace already has a default, so the
        // reseed re-creates it as NON-default and the user's choice survives.
        const custom = await call<MergeThresholdPreset>('POST', base, {
          name: 'My default',
          maxComplexity: 0.5,
          maxRisk: 0.5,
          maxImpact: 0.5,
          ciMaxAttempts: 5,
          maxRequirementIterations: 5,
          maxRequirementConcernAllowed: 'none',
          isDefault: true,
        })
        expect(custom.body.isDefault).toBe(true)
        await call('DELETE', `${base}/mp_balanced`)
        const rebalanced = await call<MergeThresholdPreset>('POST', `${base}/mp_balanced/reseed`)
        expect(rebalanced.status).toBe(200)
        expect(rebalanced.body.isDefault).toBe(false)
        const afterReseed = await call<MergeThresholdPreset[]>('GET', base)
        expect(afterReseed.body.filter((p) => p.isDefault).map((p) => p.id)).toEqual([
          custom.body.id,
        ])

        // A non-catalog id cannot be reseeded (it would be a custom preset — delete instead).
        const bad = await call('POST', `${base}/mp_not_a_builtin/reseed`)
        expect(bad.status).toBe(422)
      })
    })

    describe('runner backend connection (discriminated kind)', () => {
      type RunnerConnection = {
        kind: string
        secretKeys: string[]
        config?: { kind: string; kubernetes?: { namespace?: string; image?: string } }
      }

      it('round-trips the discriminated backend kind + config through the store', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/runner-pool/connection`

        // Register a native Kubernetes backend (no real cluster needed — register only
        // validates + persists). The `kind` column + the discriminated `config` blob must
        // round-trip identically through the D1 and Drizzle repos.
        const registered = await call<RunnerConnection>('POST', base, {
          config: {
            kind: 'kubernetes',
            kubernetes: {
              label: 'Prod',
              apiServerUrl: 'https://k8s.example:6443',
              namespace: 'cat-factory',
              image: 'ghcr.io/acme/executor:1',
            },
          },
          secrets: { apiToken: 'sa-token' },
        })
        expect(registered.status).toBe(201)
        expect(registered.body.kind).toBe('kubernetes')
        expect(registered.body.secretKeys).toContain('apiToken')

        const got = await call<{ connection: RunnerConnection | null }>('GET', base)
        expect(got.status).toBe(200)
        expect(got.body.connection?.kind).toBe('kubernetes')
        // The non-secret config is exposed (sans token) so the connect form can prefill.
        expect(got.body.connection?.config?.kind).toBe('kubernetes')
        expect(got.body.connection?.config?.kubernetes?.namespace).toBe('cat-factory')
        expect(got.body.connection?.secretKeys).toContain('apiToken')

        // Re-registering a manifest backend replaces it; the discriminator flips back.
        const manifest = await call<RunnerConnection>('POST', base, {
          config: {
            kind: 'manifest',
            manifest: {
              providerId: 'acme-pool',
              label: 'Acme',
              baseUrl: 'https://pool.test/api',
              auth: { type: 'bearer', secretRef: { key: 'API_TOKEN' } },
              dispatch: { method: 'POST', pathTemplate: '/jobs', bodyTemplate: '{}' },
              poll: { method: 'GET', pathTemplate: '/jobs/{{input.jobId}}' },
              response: { statusPath: 'state' },
            },
          },
          secrets: { API_TOKEN: 'tok' },
        })
        expect(manifest.status).toBe(201)
        expect(manifest.body.kind).toBe('manifest')
        const afterManifest = await call<{ connection: RunnerConnection | null }>('GET', base)
        expect(afterManifest.body.connection?.kind).toBe('manifest')
        expect(afterManifest.body.connection?.config?.kind).toBe('manifest')
      })
    })

    describe('custom backend kinds (programmatic registration)', () => {
      // A single-tenant / self-hosted deployment registers a bespoke environment or runner
      // backend programmatically (an import side effect) — the public extension seam that
      // replaced the removed deployment-wide provider injection. A custom kind rides the
      // contract's generic manifest member (NO new config variant), so it must: pass connect
      // validation, round-trip its kind+config through the store, be describable BEFORE the
      // first connect, and be advertised in the snapshot — identically on every runtime. A
      // facade that didn't open its repos/validation to a custom kind fails here.
      //
      // Registered BY REFERENCE into an app-owned registry the harness injects through
      // `makeApp({ backendRegistries })` — exactly how a real deployment registers a custom
      // backend (no module-global side effect, so module identity is irrelevant).
      const ENV_KIND = 'conformance-env'
      const RUNNER_KIND = 'conformance-runner'

      const customEnvBackend: EnvironmentBackendProvider = {
        kind: ENV_KIND,
        displayLabel: 'Conformance Env',
        referencedSecretKeys: () => ['ENV_TOKEN'],
        connectionMeta: (config) => ({
          providerId: ENV_KIND,
          label: 'manifest' in config ? config.manifest.label : 'Conformance Env',
          baseUrl: 'manifest' in config ? config.manifest.baseUrl : '',
        }),
        assertConfigSafe: () => {},
        toManifest: (config) => {
          if (!('manifest' in config)) throw new Error('expected a manifest-shaped custom config')
          return config.manifest
        },
        fromManifest: (manifest) => ({ kind: ENV_KIND, manifest }),
        // A custom ephemeral-environment backend rides the `remote-custom` engine.
        engines: () => ['remote-custom'],
        // describeProvider builds this to read describeConfig (absent here ⇒ no flat fields).
        buildProvider: () => ({
          provision: async () => ({
            externalId: 'e1',
            url: 'https://env.test',
            status: 'ready',
            expiresAt: null,
            access: null,
            fields: {},
          }),
          status: async () => ({
            externalId: 'e1',
            url: 'https://env.test',
            status: 'ready',
            expiresAt: null,
            access: null,
            fields: {},
          }),
          teardown: async () => ({ status: 'torn_down' }),
        }),
      }

      const customRunnerBackend: RunnerBackendProvider = {
        kind: RUNNER_KIND,
        displayLabel: 'Conformance Runner',
        referencedSecretKeys: () => ['POOL_TOKEN'],
        connectionMeta: (config) => ({
          providerId: RUNNER_KIND,
          label: 'manifest' in config ? config.manifest.label : 'Conformance Runner',
          baseUrl: 'manifest' in config ? config.manifest.baseUrl : '',
        }),
        assertConfigSafe: () => {},
        // Never dispatched in this test (the connect/describe/snapshot paths don't build it).
        buildTransport: () => {
          throw new Error('custom runner transport not dispatched in conformance')
        },
        testConnection: async () => ({ ok: true, message: 'ok' }),
      }

      // A code-defined custom PROVISION TYPE (the `custom` catalog half), registered by reference
      // exactly like the backends. It must surface in the handlers bundle's `customTypes` marked
      // `source: 'registered'` so the infra custom-type editor + the per-service provisioning
      // picker can offer it — even with no workspace-defined rows.
      const REGISTERED_TYPE = 'conformance-terraform'

      // The app-owned registries the harness injects, pre-loaded with the built-ins + the two
      // custom backends + the registered custom manifest type — by reference, so the facade sees
      // them regardless of module identity.
      const backendRegistries = createBackendRegistries()
      backendRegistries.environmentBackendRegistry.register(customEnvBackend)
      backendRegistries.runnerBackendRegistry.register(customRunnerBackend)
      backendRegistries.customManifestTypeRegistry.register({
        manifestId: REGISTERED_TYPE,
        label: 'Conformance Terraform',
        description: 'HCL plan + apply',
      })

      const envManifest = {
        providerId: ENV_KIND,
        label: 'Bespoke Envs',
        baseUrl: 'https://bespoke.test/api',
        auth: { type: 'bearer', secretRef: { key: 'ENV_TOKEN' } },
        provision: { method: 'POST', pathTemplate: '/environments' },
        response: { urlPath: 'url', statusPath: 'state', externalIdPath: 'id' },
        providerConfig: { region: 'eu' },
      }
      const runnerManifest = {
        providerId: RUNNER_KIND,
        label: 'Bespoke Pool',
        baseUrl: 'https://bespoke.test/pool',
        auth: { type: 'bearer', secretRef: { key: 'POOL_TOKEN' } },
        dispatch: { method: 'POST', pathTemplate: '/jobs', bodyTemplate: '{}' },
        poll: { method: 'GET', pathTemplate: '/jobs/{{input.jobId}}' },
        response: { statusPath: 'state' },
      }

      it('connects + round-trips a custom ENVIRONMENT backend kind through the store', async () => {
        const { call, createWorkspace } = harness.makeApp(undefined, { backendRegistries })
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/environments`

        const registered = await call<{ kind: string; secretKeys: string[] }>(
          'POST',
          `${base}/connection`,
          { config: { kind: ENV_KIND, manifest: envManifest }, secrets: { ENV_TOKEN: 'tok' } },
        )
        expect(registered.status).toBe(201)
        expect(registered.body.kind).toBe(ENV_KIND)
        expect(registered.body.secretKeys).toContain('ENV_TOKEN')

        const got = await call<{ connection: { kind: string } | null }>('GET', `${base}/connection`)
        expect(got.body.connection?.kind).toBe(ENV_KIND)

        // The custom kind is describable while connected (and its kind drives the native form).
        const descr = await call<{ kind: string }>('GET', `${base}/provider?kind=${ENV_KIND}`)
        expect(descr.status).toBe(200)
        expect(descr.body.kind).toBe('native')
      })

      it('describes a registered custom kind BEFORE the first connect', async () => {
        const { call, createWorkspace } = harness.makeApp(undefined, { backendRegistries })
        const { workspace } = await createWorkspace()
        // No connection yet — the registry still resolves the kind so the SPA can render its form.
        const descr = await call<{ providerId: string; kind: string }>(
          'GET',
          `/workspaces/${workspace.id}/environments/provider?kind=${ENV_KIND}`,
        )
        expect(descr.status).toBe(200)
        expect(descr.body.providerId).toBe(ENV_KIND)
      })

      it('connects + round-trips a custom RUNNER backend kind through the store', async () => {
        const { call, createWorkspace } = harness.makeApp(undefined, { backendRegistries })
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/runner-pool/connection`

        const registered = await call<{ kind: string; secretKeys: string[] }>('POST', base, {
          config: { kind: RUNNER_KIND, manifest: runnerManifest },
          secrets: { POOL_TOKEN: 'tok' },
        })
        expect(registered.status).toBe(201)
        expect(registered.body.kind).toBe(RUNNER_KIND)

        const got = await call<{ connection: { kind: string; config?: { kind: string } } | null }>(
          'GET',
          base,
        )
        expect(got.body.connection?.kind).toBe(RUNNER_KIND)
        expect(got.body.connection?.config?.kind).toBe(RUNNER_KIND)
      })

      it('advertises the registered backend kinds in the workspace snapshot', async () => {
        const { call, createWorkspace } = harness.makeApp(undefined, { backendRegistries })
        const { workspace } = await createWorkspace()
        const snap = await call<{
          environmentBackendKinds?: { kind: string }[]
          runnerBackendKinds?: { kind: string }[]
        }>('GET', `/workspaces/${workspace.id}`)
        expect(snap.body.environmentBackendKinds?.map((k) => k.kind)).toEqual(
          expect.arrayContaining(['manifest', 'kubernetes', ENV_KIND]),
        )
        expect(snap.body.runnerBackendKinds?.map((k) => k.kind)).toEqual(
          expect.arrayContaining(['manifest', 'kubernetes', RUNNER_KIND]),
        )
      })

      it('surfaces a programmatically-registered custom manifest type in the handlers bundle', async () => {
        // A code-registered custom provision type must appear in the catalog the SPA reads (the
        // infra custom-type editor + the per-service provisioning picker) WITHOUT any
        // workspace-defined row, marked `source: 'registered'` (read-only). A facade that forgot
        // to wire the `customManifestTypeRegistry` into `createCore` returns an empty catalog here.
        const { call, createWorkspace } = harness.makeApp(undefined, { backendRegistries })
        const { workspace } = await createWorkspace()
        const bundle = await call<{
          customTypes: { manifestId: string; label: string; source: string }[]
        }>('GET', `/workspaces/${workspace.id}/environments/handlers`)
        expect(bundle.status).toBe(200)
        const registered = bundle.body.customTypes.find((t) => t.manifestId === REGISTERED_TYPE)
        expect(registered).toBeDefined()
        expect(registered!.label).toBe('Conformance Terraform')
        expect(registered!.source).toBe('registered')
      })

      it('rejects a config whose kind collides with a reserved built-in (guard)', async () => {
        const { call, createWorkspace } = harness.makeApp(undefined, { backendRegistries })
        const { workspace } = await createWorkspace()
        // A `kubernetes` kind carrying a manifest body (the wrong shape) must be REJECTED by
        // the reserved-kind guard, not silently accepted as the generic custom member.
        const res = await call('POST', `/workspaces/${workspace.id}/environments/connection`, {
          config: { kind: 'kubernetes', manifest: envManifest },
          secrets: { ENV_TOKEN: 'tok' },
        })
        expect(res.status).toBeGreaterThanOrEqual(400)
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

      it('resolves a deployment-registered custom kind through the injected app-owned registry — on every runtime', async () => {
        // The secret-kind registry is app-owned (no module-global Map): a deployment
        // registers a custom kind BY REFERENCE into the registry the harness injects via
        // `makeApp({ backendRegistries })`, so the facade's UserSecretService describes it
        // regardless of module identity — the migration's whole point. See
        // `docs/initiatives/registry-di-migration.md`.
        const backendRegistries = createBackendRegistries()
        backendRegistries.userSecretKindRegistry.register({
          kind: 'conformance-secret',
          label: 'Conformance secret',
          configFields: [{ key: 'token', label: 'Token', secret: true, required: true }],
        })
        const app = harness.makeApp(undefined, { backendRegistries })
        const probe = app.userSecrets?.()
        if (!probe) return

        // The injected custom kind is describable...
        const custom = probe.describe('conformance-secret')
        expect(custom?.kind).toBe('conformance-secret')
        expect(custom?.supportsTest).toBe(false)
        expect(custom?.configFields.find((f) => f.secret)?.key).toBe('token')
        // ...and the built-in still resolves off the SAME registry instance.
        expect(probe.describe('github_pat')?.supportsTest).toBe(true)
      })
    })

    describe('private package registries (per-workspace npm/GitHub-Packages auth)', () => {
      it('adds, lists redacted, resolves decrypted for dispatch, and removes — identically per store', async () => {
        const app = harness.makeApp()
        // Facades without ENCRYPTION_KEY don't wire the store; nothing to assert there.
        const probe = app.packageRegistries?.()
        if (!probe) return
        const { workspace } = await app.createWorkspace()
        const base = `/workspaces/${workspace.id}/package-registries`

        const empty = await app.call<{ entries: unknown[] }>('GET', base)
        expect(empty.status).toBe(200)
        expect(empty.body.entries).toEqual([])

        // Add one entry per vendor. The list view is REDACTED: vendor + scopes + token
        // tail only — the raw token must never appear on the wire.
        const added = await app.call<{
          entries: { id: string; vendor: string; scopes: string[]; tokenTail: string }[]
        }>('POST', base, {
          ecosystem: 'npm',
          vendor: 'npmjs',
          scopes: ['@acme'],
          token: 'npm_secret_token_1234',
        })
        expect(added.status).toBe(200)
        const listed = await app.call<{
          entries: { id: string; vendor: string; scopes: string[]; tokenTail: string }[]
        }>('POST', base, {
          ecosystem: 'npm',
          vendor: 'github-packages',
          scopes: ['@acme-internal', '@acme-tools'],
          token: 'ghp_registry_secret_5678',
        })
        expect(listed.status).toBe(200)
        expect(listed.body.entries).toHaveLength(2)
        const [npmjs, ghp] = listed.body.entries
        expect(npmjs?.vendor).toBe('npmjs')
        expect(npmjs?.scopes).toEqual(['@acme'])
        expect(npmjs?.tokenTail).toBe('1234')
        expect(ghp?.vendor).toBe('github-packages')
        expect(JSON.stringify(listed.body)).not.toContain('npm_secret_token_1234')
        expect(JSON.stringify(listed.body)).not.toContain('ghp_registry_secret_5678')

        // A second entry for an already-configured vendor is a 409: the harness renders one
        // host-keyed `_authToken` per registry, so a duplicate would be silently dropped.
        const dup = await app.call('POST', base, {
          ecosystem: 'npm',
          vendor: 'npmjs',
          scopes: ['@acme-extra'],
          token: 'npm_second_token_9999',
        })
        expect(dup.status).toBe(409)

        // A malformed scope is rejected at the write boundary.
        const bad = await app.call('POST', base, {
          ecosystem: 'npm',
          vendor: 'npmjs',
          scopes: ['not-a-scope!'],
          token: 'x_token_x',
        })
        expect(bad.status).toBeGreaterThanOrEqual(400)

        // The dispatch path decrypts the sealed entries and derives the vendor host —
        // this is what rides the container job body as `packageRegistries`.
        const dispatch = await probe.resolveForDispatch(workspace.id)
        expect(dispatch).toEqual([
          {
            ecosystem: 'npm',
            host: 'registry.npmjs.org',
            scopes: ['@acme'],
            token: 'npm_secret_token_1234',
          },
          {
            ecosystem: 'npm',
            host: 'npm.pkg.github.com',
            scopes: ['@acme-internal', '@acme-tools'],
            token: 'ghp_registry_secret_5678',
          },
        ])
        // A workspace with no connection dispatches nothing (no error).
        const other = await app.createWorkspace()
        expect(await probe.resolveForDispatch(other.workspace.id)).toEqual([])

        // Remove both entries; the second removal deletes the row outright.
        const firstId = listed.body.entries[0]?.id as string
        const secondId = listed.body.entries[1]?.id as string
        expect((await app.call('DELETE', `${base}/${firstId}`)).status).toBe(204)
        // Removing an unknown entry 404s rather than silently succeeding.
        expect((await app.call('DELETE', `${base}/${firstId}`)).status).toBe(404)
        expect((await app.call('DELETE', `${base}/${secondId}`)).status).toBe(204)
        const cleared = await app.call<{ entries: unknown[] }>('GET', base)
        expect(cleared.body.entries).toEqual([])
        expect(await probe.resolveForDispatch(workspace.id)).toEqual([])
      })
    })

    describe('sensitive per-service test credentials (sealed)', () => {
      it('seals values, lists redacted refs, and removes — identically per store', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace({ seed: true })
        // Key by a demo-board block (the inspector edits a service frame; CRUD is exact-keyed
        // by block id, so any seeded block id exercises the same store round-trip).
        const base = `/workspaces/${workspace.id}/services/blk_auth/test-secrets`

        const empty = await app.call<{ blockId: string; entries: unknown[] }>('GET', base)
        // Facades without ENCRYPTION_KEY don't wire the store; nothing to assert there.
        if (empty.status === 503) return
        expect(empty.status).toBe(200)
        expect(empty.body.entries).toEqual([])

        // Seal two secrets. The view is REDACTED: key + description only — the VALUE must
        // never appear on the wire (it is sealed at rest and delivered out of band).
        const set = await app.call<{
          blockId: string
          entries: { key: string; description: string }[]
        }>('PUT', base, {
          entries: [
            {
              key: 'STRIPE_API_KEY',
              description: 'Stripe test-mode secret key',
              value: 'sk_test_SECRET_VALUE_1',
            },
            {
              key: 'SENDGRID_TOKEN',
              description: 'SendGrid sandbox token',
              value: 'SG.SECRET_VALUE_2',
            },
          ],
        })
        expect(set.status).toBe(200)
        expect(set.body.entries.map((e) => e.key)).toEqual(['STRIPE_API_KEY', 'SENDGRID_TOKEN'])
        expect(JSON.stringify(set.body)).not.toContain('sk_test_SECRET_VALUE_1')
        expect(JSON.stringify(set.body)).not.toContain('SG.SECRET_VALUE_2')

        const listed = await app.call<{ entries: { key: string; description: string }[] }>(
          'GET',
          base,
        )
        expect(listed.status).toBe(200)
        expect(listed.body.entries).toEqual([
          { key: 'STRIPE_API_KEY', description: 'Stripe test-mode secret key' },
          { key: 'SENDGRID_TOKEN', description: 'SendGrid sandbox token' },
        ])
        expect(JSON.stringify(listed.body)).not.toContain('SECRET_VALUE')

        // A duplicate key is rejected at the write boundary (keys are unique per service).
        const dup = await app.call('PUT', base, {
          entries: [
            { key: 'STRIPE_API_KEY', description: 'a', value: 'x1' },
            { key: 'STRIPE_API_KEY', description: 'b', value: 'x2' },
          ],
        })
        expect(dup.status).toBeGreaterThanOrEqual(400)

        // A non-env-var key is rejected too.
        const badKey = await app.call('PUT', base, {
          entries: [{ key: '1-bad key', description: 'nope', value: 'x' }],
        })
        expect(badKey.status).toBeGreaterThanOrEqual(400)

        // Replacing with an empty set removes the row; the view is empty again.
        const cleared = await app.call<{ entries: unknown[] }>('PUT', base, { entries: [] })
        expect(cleared.status).toBe(200)
        expect(cleared.body.entries).toEqual([])
        expect((await app.call('DELETE', base)).status).toBe(204)
        expect((await app.call<{ entries: unknown[] }>('GET', base)).body.entries).toEqual([])
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

      it('wires Linear as a task source on every facade (registered, connect, import-gated)', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace({ seed: false })
        const ws = workspace.id

        // Linear is registered symmetrically across runtimes: it shows up in the source
        // list (so the connect UI offers it), connects with a personal API key, and lists
        // back available + enabled — the same lifecycle as Jira, proving the wiring.
        const listed = await call<{ sources: TaskSourceState[] }>(
          'GET',
          `/workspaces/${ws}/task-sources`,
        )
        expect(listed.body.sources.some((s) => s.source === 'linear')).toBe(true)

        const connected = await call<{ source: string }>(
          'POST',
          `/workspaces/${ws}/task-sources/linear/connect`,
          { credentials: { apiKey: 'lin_api_secret_key_123' } },
        )
        expect(connected.status).toBe(201)
        expect(JSON.stringify(connected.body)).not.toContain('lin_api_secret_key_123')

        const after = await call<{ sources: TaskSourceState[] }>(
          'GET',
          `/workspaces/${ws}/task-sources`,
        )
        const linear = after.body.sources.find((s) => s.source === 'linear')
        expect(linear?.available).toBe(true)
        expect(linear?.enabled).toBe(true)
      })

      it('wires the Linear OAuth + team-picker routes on every facade', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace({ seed: false })
        const ws = workspace.id

        // The descriptor advertises the OAuth connect option (the SPA shows the
        // "Connect with Linear" button), in addition to the manual API-key field.
        const listed = await call<{ sources: TaskSourceState[] }>(
          'GET',
          `/workspaces/${ws}/task-sources`,
        )
        const linear = listed.body.sources.find((s) => s.source === 'linear')
        expect(linear?.oauth).toBe(true)

        // The install-url route is wired but reports 503 until the deployment configures
        // a Linear OAuth app (the conformance harness leaves it unconfigured).
        const installUrl = await call('GET', `/workspaces/${ws}/task-sources/linear/install-url`)
        expect(installUrl.status).toBe(503)

        // The team-picker route is wired; with no Linear connection it refuses (409)
        // rather than 404 — proving the route exists symmetrically on both runtimes.
        const teams = await call('GET', `/workspaces/${ws}/task-sources/linear/teams`)
        expect(teams.status).toBe(409)
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

      it('connects, lists (secret-free), and disconnects Figma (per-workspace PAT)', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/document-sources`

        // Figma is wired on every facade beside Notion/Confluence (a per-workspace PAT;
        // normalizeConnection is pure, so no network). The token never leaves the backend.
        const connected = await call<{ source: string; label: string }>(
          'POST',
          `${base}/figma/connect`,
          { credentials: { apiToken: 'figd_secret-figma-token-xyz' } },
        )
        expect(connected.status).toBe(201)
        expect(connected.body.source).toBe('figma')
        expect(JSON.stringify(connected.body)).not.toContain('secret-figma-token')

        const listed = await call<{ connections: { source: string }[] }>(
          'GET',
          `${base}/connections`,
        )
        expect(listed.body.connections.map((c) => c.source)).toEqual(['figma'])
        expect(JSON.stringify(listed.body)).not.toContain('secret-figma-token')

        const del = await call('DELETE', `${base}/figma/connection`)
        expect(del.status).toBe(204)
        const afterDelete = await call<{ connections: unknown[] }>('GET', `${base}/connections`)
        expect(afterDelete.body.connections).toEqual([])
      })

      it('wires Linear as a document source on every facade (connect, list, disconnect)', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/document-sources`

        // Linear is registered symmetrically across runtimes: a personal API key
        // connects, lists back as metadata only, and disconnects — the same lifecycle
        // as Notion, proving the provider is wired (not 503/404) on this facade.
        const connected = await call<{ source: string }>('POST', `${base}/linear/connect`, {
          credentials: { apiKey: 'lin_api_secret_key_123' },
        })
        expect(connected.status).toBe(201)
        expect(connected.body.source).toBe('linear')
        expect(JSON.stringify(connected.body)).not.toContain('lin_api_secret_key_123')

        const listed = await call<{ connections: { source: string }[] }>(
          'GET',
          `${base}/connections`,
        )
        expect(listed.body.connections.map((c) => c.source)).toEqual(['linear'])
        expect(JSON.stringify(listed.body)).not.toContain('lin_api_secret_key_123')

        const del = await call('DELETE', `${base}/linear/connection`)
        expect(del.status).toBe(204)
        const afterDelete = await call<{ connections: unknown[] }>('GET', `${base}/connections`)
        expect(afterDelete.body.connections).toEqual([])
      })

      it('connects, lists (secret-free), and disconnects Zeplin (per-workspace PAT)', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const base = `/workspaces/${workspace.id}/document-sources`

        // Zeplin is the second design source, wired on every facade beside Figma (a
        // per-workspace Bearer PAT; normalizeConnection is pure, so no network). It proves
        // the design abstraction is not Figma-shaped — a different content model (screens +
        // a handoff design system) rides the same provider port. The token never leaves the
        // backend.
        const connected = await call<{ source: string }>('POST', `${base}/zeplin/connect`, {
          credentials: { apiToken: 'zpn-secret-zeplin-token-xyz' },
        })
        expect(connected.status).toBe(201)
        expect(connected.body.source).toBe('zeplin')
        expect(JSON.stringify(connected.body)).not.toContain('secret-zeplin-token')

        const listed = await call<{ connections: { source: string }[] }>(
          'GET',
          `${base}/connections`,
        )
        expect(listed.body.connections.map((c) => c.source)).toEqual(['zeplin'])
        expect(JSON.stringify(listed.body)).not.toContain('secret-zeplin-token')

        const del = await call('DELETE', `${base}/zeplin/connection`)
        expect(del.status).toBe(204)
        const afterDelete = await call<{ connections: unknown[] }>('GET', `${base}/connections`)
        expect(afterDelete.body.connections).toEqual([])
      })

      it('persists workspace+DocKind template (singular) and exemplar (multi) role links', async () => {
        // WS1 items 2–4: the role-tagged document links a workspace attaches to a DocKind. The
        // link WRITE path needs an imported document row (import needs a live source the dev-open
        // HTTP path can't reach), so drive the persistence through the repository probe — asserting
        // template singular-replace, exemplar multi, the management list, and the parsed-template
        // override behave identically on D1 and Postgres.
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const ws = workspace.id
        const repo = app.documentRepository()
        const doc = (externalId: string, title: string, body: string): DocumentRecord => ({
          workspaceId: ws,
          source: 'github',
          externalId,
          title,
          url: `https://github.com/o/r/blob/HEAD/${externalId}`,
          excerpt: '',
          body,
          contentHash: '',
          linkedBlockId: null,
          role: null,
          docKind: null,
          syncedAt: 1_000,
          deletedAt: null,
        })
        await repo.upsert(
          doc(
            'docs/templates/rfc-a.md',
            'RFC template A',
            '# RFC\n\n## Summary\n\n## Motivation\n\n## Rollout',
          ),
        )
        await repo.upsert(
          doc('docs/templates/rfc-b.md', 'RFC template B', '# RFC\n\n## Abstract\n\n## Design'),
        )
        await repo.upsert(
          doc('docs/examples/good-rfc.md', 'A great RFC', '# Example RFC\n\n## Summary'),
        )

        // Link A as the rfc template.
        await repo.clearRoleForKind(ws, 'template', 'rfc')
        await repo.setRole(ws, 'github', 'docs/templates/rfc-a.md', 'template', 'rfc')
        const tplA = await repo.getRoleLink(ws, 'template', 'rfc')
        expect(tplA?.externalId).toBe('docs/templates/rfc-a.md')
        // The linked template's parsed sections become the kind's effective template — the SAME
        // override the doc-quality gate resolves, so the writer and gate never disagree.
        expect(resolveDocTemplate('rfc', tplA!.body).sections.map((s) => s.title)).toEqual([
          'Summary',
          'Motivation',
          'Rollout',
        ])

        // Relinking a new template for the kind REPLACES the prior one (singular per kind).
        await repo.clearRoleForKind(ws, 'template', 'rfc')
        await repo.setRole(ws, 'github', 'docs/templates/rfc-b.md', 'template', 'rfc')
        expect((await repo.getRoleLink(ws, 'template', 'rfc'))?.externalId).toBe(
          'docs/templates/rfc-b.md',
        )
        expect((await repo.get(ws, 'github', 'docs/templates/rfc-a.md'))?.role).toBeNull()

        // Exemplars are additive (multi-valued per kind).
        await repo.setRole(ws, 'github', 'docs/examples/good-rfc.md', 'exemplar', 'rfc')
        expect((await repo.listRoleLinks(ws, 'exemplar', 'rfc')).map((d) => d.externalId)).toEqual([
          'docs/examples/good-rfc.md',
        ])

        // The management list surfaces every role-tagged document (template + exemplars).
        const all = await repo.listRoleLinksByWorkspace(ws)
        expect(new Set(all.map((d) => `${d.role}:${d.externalId}`))).toEqual(
          new Set(['template:docs/templates/rfc-b.md', 'exemplar:docs/examples/good-rfc.md']),
        )

        // Unlinking clears the tag — the built-in template resumes for the kind.
        await repo.clearRole(ws, 'github', 'docs/templates/rfc-b.md')
        expect(await repo.getRoleLink(ws, 'template', 'rfc')).toBeNull()
      })

      it('persists an interactive document-interview session identically (WS5)', async () => {
        // The interactive-interview session (WS5) is written by the interviewer LLM (off in
        // conformance), so — like the role-link probe above — exercise the persistence through
        // the repository directly. Asserting upsert / getByBlock-newest-wins / get / deleteByBlock
        // here means a facade that maps a column differently (D1 vs Drizzle) fails a shared test.
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const ws = workspace.id
        const repo = app.docInterviewRepository()

        // A fresh block has no session.
        expect(await repo.getByBlock(ws, 'task_doc')).toBeNull()

        // Round-trip an `awaiting` session with a pending question.
        await repo.upsert(ws, {
          id: 'dis-1',
          blockId: 'task_doc',
          status: 'awaiting',
          round: 1,
          maxRounds: 4,
          qa: [{ id: 'diq-1', question: 'Who is the audience?', answer: '' }],
          brief: null,
          model: 'openai:gpt',
          createdAt: 1_000,
          updatedAt: 1_000,
        })
        const loaded = await repo.getByBlock(ws, 'task_doc')
        expect(loaded?.status).toBe('awaiting')
        expect(loaded?.round).toBe(1)
        expect(loaded?.qa).toEqual([{ id: 'diq-1', question: 'Who is the audience?', answer: '' }])
        expect(await repo.get(ws, 'dis-1')).not.toBeNull()

        // An upsert on the same id converges it (answered digest + synthesized brief).
        await repo.upsert(ws, {
          id: 'dis-1',
          blockId: 'task_doc',
          status: 'done',
          round: 2,
          maxRounds: 4,
          qa: [{ id: 'diq-1', question: 'Who is the audience?', answer: 'Platform engineers' }],
          brief: '# Authoring brief\n\nWrite for platform engineers.',
          model: 'openai:gpt',
          createdAt: 1_000,
          updatedAt: 2_000,
        })
        const done = await repo.getByBlock(ws, 'task_doc')
        expect(done?.status).toBe('done')
        expect(done?.brief).toContain('platform engineers')
        expect(done?.qa[0]?.answer).toBe('Platform engineers')

        // deleteByBlock clears the block's session(s).
        await repo.deleteByBlock(ws, 'task_doc')
        expect(await repo.getByBlock(ws, 'task_doc')).toBeNull()
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
        backendRegistries.environmentBackendRegistry.register(
          composeEnvironmentBackend(fakeRuntime),
        )

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
        // store into the context builder would silently ship a bare child prompt. The preset is a
        // module-global registration today (slice 5 migrates it to DI); scope + clear it here.
        const ADDITION = 'Follow the org connector architecture and consume the build handoff.'
        registerInitiativePreset({
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
        try {
          const app = harness.makeApp({ confidence: 1, echoPreset: true })
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
        } finally {
          clearRegisteredInitiativePresets()
        }
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
        // wiring end-to-end — `block.mergePresetId` → `resolveMergePreset` repository lookup →
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
        const presets = await app.call<MergeThresholdPreset[]>(
          'GET',
          `/workspaces/${wsId}/merge-presets`,
        )
        expect(presets.body.some((p) => p.id === 'mp_manual_review')).toBe(true)
        // Pin the human-review-only preset on the task.
        await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
          mergePresetId: 'mp_manual_review',
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
        const strict = await app.call<MergeThresholdPreset>(
          'POST',
          `/workspaces/${wsId}/merge-presets`,
          {
            name: 'Strict',
            maxComplexity: 0.3,
            maxRisk: 0.3,
            maxImpact: 0.3,
            ciMaxAttempts: 10,
            maxRequirementIterations: 6,
            maxRequirementConcernAllowed: 'none',
          },
        )
        expect(strict.status).toBe(201)
        await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
          mergePresetId: strict.body.id,
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

      it('round-trips the issue-intake config through create, update, and clear', async () => {
        // `issueIntake` (bug-triage Phase D) is a persisted JSON column on
        // `pipeline_schedules`, so this pins the column mapping on BOTH runtimes —
        // a facade that drops it on save would leave every bug-intake fire scopeless.
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const issueIntake = {
          source: 'jira',
          board: { jiraProjectKey: 'PROJ' },
          predicates: { titleFragment: 'crash', labels: ['bug'], issueType: 'Bug' },
        }
        const created = await app.call<PipelineSchedule>(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines`,
          {
            frameId: 'blk_auth',
            pipelineId: 'pl_dep_update',
            name: 'Bug triage',
            recurrence,
            issueIntake,
          },
        )
        expect(created.status).toBe(201)
        expect(created.body.issueIntake).toEqual(issueIntake)

        // The config survives a persistence round-trip (list re-reads the row).
        const listed = await app.call<PipelineSchedule[]>(
          'GET',
          `/workspaces/${wsId}/recurring-pipelines`,
        )
        expect(listed.body.find((s) => s.id === created.body.id)?.issueIntake).toEqual(issueIntake)

        // PATCH replaces the config…
        const replaced = await app.call<PipelineSchedule>(
          'PATCH',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}`,
          {
            issueIntake: {
              source: 'github',
              board: { githubRepo: 'octo/app' },
              predicates: {},
              inProgressLabel: 'bot-working',
            },
          },
        )
        expect(replaced.status).toBe(200)
        expect(replaced.body.issueIntake?.source).toBe('github')
        expect(replaced.body.issueIntake?.inProgressLabel).toBe('bot-working')

        // …an unrelated PATCH leaves it untouched, and null clears it.
        const renamed = await app.call<PipelineSchedule>(
          'PATCH',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}`,
          { name: 'Renamed' },
        )
        expect(renamed.body.issueIntake?.source).toBe('github')
        const cleared = await app.call<PipelineSchedule>(
          'PATCH',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}`,
          { issueIntake: null },
        )
        expect(cleared.status).toBe(200)
        expect(cleared.body.issueIntake).toBeUndefined()
        const after = await app.call<PipelineSchedule[]>(
          'GET',
          `/workspaces/${wsId}/recurring-pipelines`,
        )
        expect(after.body.find((s) => s.id === created.body.id)?.issueIntake).toBeUndefined()
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

      it('bug-intake picks up a matching issue, seeds the block, and drives to completion', async () => {
        // A Jira fake source, CONNECTED (so it is `offered` — available + enabled — which the
        // schedule intake-config validation requires), pre-loaded with an open bug. The suite holds
        // the instance to seed the backlog + inspect the recorded query.
        const source = new FakeTaskSourceProvider('jira')
        source.set('42', { title: 'Login crashes on submit', labels: ['bug'], status: 'open' })
        const app = harness.makeApp({ confidence: 1 }, { taskSourceProviders: [source] })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        // Connect the source so it counts as a usable intake source (the fake accepts any creds).
        await app.call('POST', `/workspaces/${wsId}/task-sources/jira/connect`, {
          credentials: {
            baseUrl: 'https://acme.atlassian.net',
            accountEmail: 'd@a.io',
            apiToken: 't',
          },
        })

        // A recurring pipeline whose first step is `bug-intake`; a trailing `architect` step
        // proves the run advances past intake when an issue is picked up.
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Bug triage',
          agentKinds: ['bug-intake', 'architect'],
          availability: 'recurring',
        })
        const created = await app.call<PipelineSchedule>(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines`,
          {
            frameId: 'blk_auth',
            pipelineId: pipeline.body.id,
            name: 'Nightly bug triage',
            recurrence,
            issueIntake: {
              source: 'jira',
              board: { jiraProjectKey: 'PROJ' },
              predicates: { titleFragment: 'crash', labels: ['bug'] },
            },
          },
        )
        expect(created.status).toBe(201)
        const blockId = created.body.blockId

        const fired = await app.call(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}/run-now`,
        )
        expect(fired.status).toBe(200)

        const driven = await app.drive(wsId)
        const run = driven.find((e) => e.blockId === blockId)
        expect(run?.status).toBe('done')
        // The intake step recorded the pickup, and NEITHER step was skipped (the fix work ran).
        const intakeStep = run?.steps.find((s) => s.agentKind === 'bug-intake')
        expect(intakeStep?.output).toContain('42')
        expect(intakeStep?.skipped).toBeFalsy()
        expect(run?.steps.find((s) => s.agentKind === 'architect')?.skipped).toBeFalsy()

        // The search ran with the schedule's predicates pushed into the intake query.
        expect(source.intakeCalls).toHaveLength(1)
        expect(source.intakeCalls[0]!.query.titleFragment).toBe('crash')

        // The reused block was reseeded from the picked issue (title keyed by the external id).
        const block = await app.blockRepository().get(wsId, blockId)
        expect(block?.title).toContain('42')
        expect(block?.title).toContain('Login crashes on submit')
      })

      it('bug-intake with no matching issue completes the run, skipping the remaining steps', async () => {
        // The backlog holds only a NON-matching issue (wrong title), so nothing qualifies. A
        // CONNECTED Jira source (the schedule validation requires an offered source).
        const source = new FakeTaskSourceProvider('jira')
        source.set('7', { title: 'Update docs', labels: ['bug'], status: 'open' })
        const app = harness.makeApp({ confidence: 1 }, { taskSourceProviders: [source] })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        await app.call('POST', `/workspaces/${wsId}/task-sources/jira/connect`, {
          credentials: {
            baseUrl: 'https://acme.atlassian.net',
            accountEmail: 'd@a.io',
            apiToken: 't',
          },
        })

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Bug triage',
          agentKinds: ['bug-intake', 'architect'],
          availability: 'recurring',
        })
        const created = await app.call<PipelineSchedule>(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines`,
          {
            frameId: 'blk_auth',
            pipelineId: pipeline.body.id,
            name: 'Nightly bug triage',
            recurrence,
            issueIntake: {
              source: 'jira',
              board: { jiraProjectKey: 'PROJ' },
              predicates: { titleFragment: 'crash' },
            },
          },
        )
        const blockId = created.body.blockId
        const blockBefore = await app.blockRepository().get(wsId, blockId)

        await app.call('POST', `/workspaces/${wsId}/recurring-pipelines/${created.body.id}/run-now`)
        const driven = await app.drive(wsId)
        const run = driven.find((e) => e.blockId === blockId)

        // The run completes SUCCESSFULLY, with the trailing step skipped (nothing to fix).
        expect(run?.status).toBe('done')
        const intakeStep = run?.steps.find((s) => s.agentKind === 'bug-intake')
        expect(intakeStep?.skipped).toBeFalsy()
        expect(intakeStep?.output).toContain('No matching')
        expect(run?.steps.find((s) => s.agentKind === 'architect')?.skipped).toBe(true)

        // No issue was picked up, so the block's title is untouched, the block is finalized `done`
        // (NOT `pr_ready`), and — since nothing was worked and no PR opened — the no-op raises NO
        // `pipeline_complete` "confirm + merge" notification.
        const blockAfter = await app.blockRepository().get(wsId, blockId)
        expect(blockAfter?.title).toBe(blockBefore?.title)
        expect(blockAfter?.status).toBe('done')
        const notes = await app.notificationRepository().listOpen(wsId)
        expect(notes.some((n) => n.blockId === blockId)).toBe(false)
      })

      it('rejects a bug-intake schedule with no issue-intake configuration', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Bug triage',
          agentKinds: ['bug-intake', 'architect'],
          availability: 'recurring',
        })
        // Attaching it to a schedule with no `issueIntake` is refused up front (every fire would
        // otherwise silently no-op — nothing to pull work from).
        const created = await app.call<PipelineSchedule>(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines`,
          { frameId: 'blk_auth', pipelineId: pipeline.body.id, name: 'Nightly', recurrence },
        )
        expect(created.status).toBe(422)
      })

      // Phase H — the whole built-in `pl_bug_triage` pipeline end to end on a schedule: a fire
      // pulls one matching issue (bug-intake), investigates it (bug-investigator → clear ⇒ the
      // clarity gate auto-passes with no park), estimates it (task-estimator), reproduces it
      // (repro-test), fixes it (coder), reviews it (reviewer), tests it (tester-api, greenlights),
      // and drives the conflicts/ci/merger tail to an auto-merge. This asserts the SEEDED
      // definition (`availability: 'recurring'`, the exact step order) drives to completion
      // identically on every runtime — not a hand-built pipeline. The investigator/repro results
      // ride ONE lenient superset `customResult`: each structured kind reads only its own fields
      // (both schemas strip the rest), so the single fake result satisfies both.
      it('drives the built-in pl_bug_triage pipeline end to end: intake → investigate → repro → fix → merge', async () => {
        const source = new FakeTaskSourceProvider('jira')
        source.set('99', {
          title: 'Checkout crashes on empty cart',
          labels: ['bug'],
          status: 'open',
        })
        const app = harness.makeApp(
          {
            confidence: 1,
            // A superset of the bug-investigator triage (clear ⇒ auto-pass) and the repro-test
            // outcome (reproduced) — each kind parses only its own fields.
            customResult: {
              clarity: 'clear',
              summary: 'The checkout handler dereferences an empty cart.',
              rootCauseHypotheses: ['Missing empty-cart guard in checkout()'],
              affectedRepos: [],
              suggestedReproductions: ['POST /checkout with an empty cart'],
              questions: [],
              outcome: 'reproduced',
              testPaths: ['test/checkout.test.ts'],
              notes: 'Fails for the reported reason (empty-cart dereference).',
            },
          },
          { taskSourceProviders: [source] },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        await app.call('POST', `/workspaces/${wsId}/task-sources/jira/connect`, {
          credentials: {
            baseUrl: 'https://acme.atlassian.net',
            accountEmail: 'd@a.io',
            apiToken: 't',
          },
        })

        // The pipeline is the SEEDED built-in (auto-seeded into every workspace), attached to a
        // schedule with its issue-intake config — exactly how a real deployment runs it.
        const created = await app.call<PipelineSchedule>(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines`,
          {
            frameId: 'blk_auth',
            pipelineId: BUG_TRIAGE_PIPELINE_ID,
            name: 'Nightly bug triage',
            recurrence,
            issueIntake: {
              source: 'jira',
              board: { jiraProjectKey: 'PROJ' },
              predicates: { titleFragment: 'crash', labels: ['bug'] },
            },
          },
        )
        expect(created.status).toBe(201)
        const blockId = created.body.blockId

        const fired = await app.call(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}/run-now`,
        )
        expect(fired.status).toBe(200)

        const run = (await app.drive(wsId)).find((e) => e.blockId === blockId)
        // The full pipeline reached an auto-merge (confidence 1) — `done`, every step finished.
        expect(run?.status).toBe('done')
        const step = (kind: string) => run?.steps.find((s) => s.agentKind === kind)
        expect(step('bug-intake')?.output).toContain('99')
        expect(step('bug-intake')?.skipped).toBeFalsy()
        // Investigation was `clear`, so the clarity gate auto-passed (no park, run stayed running).
        expect((step('bug-investigator')?.custom as { clarity?: string })?.clarity).toBe('clear')
        expect(step('clarity-review')?.state).toBe('done')
        // The reproduction reproduced and the coder fixed it — both ran, neither blocked the run.
        expect((step('repro-test')?.custom as { outcome?: string })?.outcome).toBe('reproduced')
        expect(step('coder')?.state).toBe('done')
        expect(step('reviewer')?.state).toBe('done')
        expect(step('merger')?.state).toBe('done')
        // The reused block was reseeded from the picked issue and finalized `done`.
        const block = await app.blockRepository().get(wsId, blockId)
        expect(block?.status).toBe('done')
        expect(block?.title).toContain('Checkout crashes on empty cart')
      })

      it('persists an on-demand schedule (no cadence) and fires it via run-now', async () => {
        const app = harness.makeApp({ confidence: 1 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'On-demand inline',
          agentKinds: ['architect'],
        })
        // No `recurrence` on the body — an on-demand schedule needs none.
        const created = await app.call<PipelineSchedule>(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines`,
          {
            frameId: 'blk_auth',
            pipelineId: pipeline.body.id,
            name: 'Manual pass',
            onDemand: true,
          },
        )
        expect(created.status).toBe(201)
        expect(created.body.onDemand).toBe(true)

        // The flag round-trips through the store on both runtimes.
        const snapshot = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        expect(
          snapshot.body.recurringPipelines?.find((s) => s.id === created.body.id)?.onDemand,
        ).toBe(true)

        // Manual run-now still fires it (the credential gate is a no-op with no individual model).
        const fired = await app.call(
          'POST',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}/run-now`,
        )
        expect(fired.status).toBe(200)
        const runs = await app.call<ScheduleRun[]>(
          'GET',
          `/workspaces/${wsId}/recurring-pipelines/${created.body.id}/runs`,
        )
        expect(runs.body).toHaveLength(1)
        expect(runs.body[0]!.executionId).toBeTruthy()
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

        // Switching to Linear persists the team id (the one tracker-settings column the
        // Linear support adds) and clears the Jira project key — identical on both stores.
        const linear = await app.call<TrackerSettings>(
          'PUT',
          `/workspaces/${wsId}/tracker-settings`,
          { tracker: 'linear', linearTeamId: 'team_abc123' },
        )
        expect(linear.body.tracker).toBe('linear')
        expect(linear.body.linearTeamId).toBe('team_abc123')
        expect(linear.body.jiraProjectKey).toBeNull()
        const linearSnapshot = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        expect(linearSnapshot.body.trackerSettings?.tracker).toBe('linear')
        expect(linearSnapshot.body.trackerSettings?.linearTeamId).toBe('team_abc123')
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

    // The `bug-investigator` is a structured `container-explore` kind whose `clarity`/`questions`
    // drive the downstream `clarity-review` gate (phase F): `clear` auto-passes with no human
    // park; `needs_clarification` seeds one finding per question and parks the run for a human.
    // The seed is DETERMINISTIC — no reviewer model — so the gate behaves identically on every
    // runtime (conformance wires no reviewer model), which is exactly what these assert.
    describe('bug-triage investigation + clarification (phase F)', () => {
      type SeededReview = {
        id: string
        status: string
        items: { id: string; status: string; detail: string }[]
      }
      const investigatorResult = (over: Record<string, unknown>): Record<string, unknown> => ({
        clarity: 'clear',
        summary: 'The submit handler swallows the validation error.',
        rootCauseHypotheses: ['Unhandled promise rejection in onSubmit'],
        affectedRepos: [],
        suggestedReproductions: ['Submit the form with an empty email'],
        questions: [],
        ...over,
      })

      it('auto-passes the clarity gate when the investigator reports the report is clear', async () => {
        const app = harness.makeApp({ customResult: investigatorResult({ clarity: 'clear' }) })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Triage & investigate',
          agentKinds: ['bug-investigator', 'clarity-review', 'architect'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)

        // Clear ⇒ no park: the run drives straight through the clarity gate to the architect.
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        expect(exec.steps.find((s) => s.agentKind === 'clarity-review')?.state).toBe('done')
        expect(exec.steps.find((s) => s.agentKind === 'architect')?.state).toBe('done')

        // The investigator recorded its structured triage on `step.custom`, and the
        // post-completion resolver rendered a prose digest onto `step.output` (what the
        // downstream `priorOutputs` carries).
        const investigator = exec.steps.find((s) => s.agentKind === 'bug-investigator')!
        expect((investigator.custom as { clarity?: string } | undefined)?.clarity).toBe('clear')
        expect(investigator.output).toContain('Investigation summary')
        expect(investigator.output).toContain('swallows the validation error')

        // The clarity review auto-passed (settled `incorporated`, no findings, no model).
        const review = await app.call<SeededReview | null>(
          'GET',
          `/workspaces/${wsId}/blocks/task_login/clarity-review`,
        )
        expect(review.body?.status).toBe('incorporated')
        expect(review.body?.items ?? []).toHaveLength(0)
      })

      it('parks the clarity gate for a human on needs_clarification, then resumes on proceed', async () => {
        const app = harness.makeApp({
          customResult: investigatorResult({
            clarity: 'needs_clarification',
            questions: ['What are the exact reproduction steps?', 'Which browser and version?'],
          }),
        })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Triage & investigate',
          agentKinds: ['bug-investigator', 'clarity-review', 'architect'],
        })
        await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })

        // needs_clarification ⇒ the gate seeds one finding per question and PARKS the run.
        let exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('blocked')
        expect(exec.steps.find((s) => s.agentKind === 'clarity-review')?.state).toBe(
          'waiting_decision',
        )
        expect(exec.steps.find((s) => s.agentKind === 'architect')?.state).not.toBe('done')

        // The seeded review carries one OPEN finding per investigator question — no LLM ran.
        const review = await app.call<SeededReview | null>(
          'GET',
          `/workspaces/${wsId}/blocks/task_login/clarity-review`,
        )
        expect(review.body?.status).toBe('ready')
        const items = review.body?.items ?? []
        expect(items).toHaveLength(2)
        expect(items.every((i) => i.status === 'open')).toBe(true)
        expect(items.map((i) => i.detail)).toContain('Which browser and version?')

        // Resume: dismiss both questions, then proceed — advancing the parked run (no model).
        for (const item of items) {
          const dismissed = await app.call(
            'PATCH',
            `/workspaces/${wsId}/clarity-reviews/${review.body!.id}/items/${item.id}`,
            { status: 'dismissed' },
          )
          expect(dismissed.status).toBe(200)
        }
        const proceeded = await app.call(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/clarity-review/proceed`,
        )
        expect(proceeded.status).toBe(200)

        exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        expect(exec.steps.find((s) => s.agentKind === 'clarity-review')?.state).toBe('done')
        expect(exec.steps.find((s) => s.agentKind === 'architect')?.state).toBe('done')
      })
    })

    // The `repro-test` is a structured `container-coding` kind (phase G): it writes a failing
    // reproduction test (or concedes `not_reproducible`) and returns a `{ outcome, testPaths,
    // notes }` assessment. A concede NEVER fails the run — a post-completion resolver folds the
    // outcome into `step.output` and the run advances to the coder either way. These assert both
    // the reproduced and the conceded path reach the coder identically on every runtime.
    describe('bug-triage reproduction (phase G)', () => {
      const runRepro = async (
        outcome: 'reproduced' | 'not_reproducible',
        customResult: Record<string, unknown>,
      ): Promise<ExecutionInstance> => {
        const app = harness.makeApp({ customResult })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: `Reproduce & fix (${outcome})`,
          agentKinds: ['repro-test', 'coder'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)
        return (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
      }

      it('records a reproduced outcome, then advances to the coder', async () => {
        const exec = await runRepro('reproduced', {
          outcome: 'reproduced',
          testPaths: ['test/submit.test.ts'],
          notes: 'Fails for the reported reason (unhandled rejection).',
        })
        expect(exec.status).toBe('done')

        const repro = exec.steps.find((s) => s.agentKind === 'repro-test')!
        expect(repro.state).toBe('done')
        // The structured outcome is kept on `step.custom` for the generic-structured view.
        expect((repro.custom as { outcome?: string } | undefined)?.outcome).toBe('reproduced')
        // The post-completion resolver rendered a prose digest onto `step.output`.
        expect(repro.output).toContain('Reproduction test')
        expect(repro.output).toContain('Reproduced')
        expect(repro.output).toContain('`test/submit.test.ts`')

        // The coder ran after the reproduction step — a repro-test never blocks the run.
        expect(exec.steps.find((s) => s.agentKind === 'coder')?.state).toBe('done')
      })

      it('concedes not_reproducible without failing the run, still reaching the coder', async () => {
        const exec = await runRepro('not_reproducible', {
          outcome: 'not_reproducible',
          testPaths: [],
          notes: 'Needs production data to trigger; could not reproduce locally.',
        })
        // Conceding is a SUCCESSFUL run (only infra/eviction fails a repro-test).
        expect(exec.status).toBe('done')

        const repro = exec.steps.find((s) => s.agentKind === 'repro-test')!
        expect(repro.state).toBe('done')
        expect((repro.custom as { outcome?: string } | undefined)?.outcome).toBe('not_reproducible')
        expect(repro.output).toContain('Not reproducible')
        expect(repro.output).toContain('Needs production data')

        // The coder still runs — a conceded reproduction does not stop the pipeline.
        expect(exec.steps.find((s) => s.agentKind === 'coder')?.state).toBe('done')
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

      it('lists every account a user can switch between (batched multi-membership resolve)', async () => {
        const ob = harness.makeApp().onboarding()
        // An org owner belongs to BOTH the org and their auto-seeded personal account, so the
        // switcher list resolves more than one membership's account in a single batched read —
        // which must map identically on every store.
        const org = await ob.makeOrgOwner('Switcher Org')
        const accounts = await ob.accountsForUser({
          id: org.ownerUserId,
          login: 'switcher-owner',
          name: 'Switcher Owner',
        })
        expect(accounts.some((a) => a.id === org.accountId && a.type === 'org')).toBe(true)
        expect(accounts.some((a) => a.type === 'personal')).toBe(true)
        // Personal account is listed first (the stable switcher order).
        expect(accounts[0]?.type).toBe('personal')
        // Every listed account carries the caller's role(s) — proving the membership join, not
        // just the id resolve, survives the batched read.
        expect(accounts.every((a) => a.roles.length > 0)).toBe(true)
      })

      it('resolves ONE personal account under concurrent first sign-in (no duplicate-key race)', async () => {
        const ob = harness.makeApp().onboarding()
        const user = {
          id: `usr_race_${crypto.randomUUID()}`,
          login: 'race-owner',
          name: 'Race Owner',
        }
        // Fire the first-load resolution many times at once: each runs ensurePersonalAccount
        // before any INSERT commits, so a check-then-create would race to a duplicate-key 500
        // on the personal-account unique index. The atomic get-or-create must instead converge
        // every caller on the same single account, with no rejection.
        const ids = await ob.concurrentPersonalAccounts(user, 8)
        expect(ids).toHaveLength(8)
        expect(new Set(ids).size).toBe(1)
        // And a follow-up read returns that same one account — no orphan duplicates were left.
        const after = await ob.accountsForUser(user)
        const personal = after.filter((a) => a.type === 'personal')
        expect(personal).toHaveLength(1)
        expect(personal[0]?.id).toBe(ids[0])
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
