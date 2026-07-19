import { allPullRequests } from '@cat-factory/contracts'
import {
  type Block,
  type CreateReviewInput,
  type ExecutionInstance,
  type ModelPreset,
  type Notification,
  type Pipeline,
  type PrReviewStepState,
  type RepoFiles,
  type Workspace,
  type WorkspaceSnapshot,
  seedPipelines,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceApp, ConformanceHarness } from '../harness.js'
import { spawnedInitiative } from './shared.js'

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

      it('serves /internal/github/installation-token with the machine-token gate active', async () => {
        const { call } = harness.makeApp()
        // The GitHub delegation endpoint is mounted by the shared controller on both facades
        // and checks the machine token FIRST (before the "is a GitHub App wired" 503), so an
        // unauthenticated call is a 403 everywhere — the drift guard that the endpoint exists
        // and is machine-gated regardless of whether this facade configures a GitHub App.
        const res = await call('POST', '/internal/github/installation-token', {
          installationId: 1,
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

      it('cascades the delete across workspace-scoped tables (no permanent orphans)', async () => {
        // The delete cascade is driven by the shared kernel list WORKSPACE_SCOPED_TABLES on BOTH
        // facades. Before it covered the full list, deleting a board left rows in ~40 other
        // workspace-scoped tables (notifications, initiatives, the review/session tables, …)
        // orphaned forever. Seed two of those tables through the real per-runtime stores, delete
        // the board, and assert BOTH stores reclaimed the rows — so a facade that mapped the
        // cascade differently fails here on D1 or Postgres instead of silently orphaning.
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        await app.notificationRepository().upsert(wsId, {
          id: `ntf-${wsId}`,
          type: 'merge_review',
          status: 'open',
          severity: 'normal',
          blockId: null,
          executionId: null,
          title: 'Review',
          body: 'body',
          payload: null,
          createdAt: 1,
          resolvedAt: null,
        })
        await app.initiativeRepository().insert(wsId, spawnedInitiative('init_orphan_anchor'))

        // Sanity: both rows are present before the delete.
        expect(await app.notificationRepository().listOpen(wsId)).toHaveLength(1)
        expect(await app.initiativeRepository().list(wsId)).toHaveLength(1)

        const del = await app.call('DELETE', `/workspaces/${wsId}`)
        expect(del.status).toBe(204)

        // …and neither store keeps a row for the deleted workspace.
        expect(await app.notificationRepository().listOpen(wsId)).toEqual([])
        expect(await app.initiativeRepository().list(wsId)).toEqual([])
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

      // Race-audit 2.3: `cancel()` deletes the run row, and a stale in-flight driver write must
      // NOT bring it back. `compareAndSwap` only ever UPDATEs an existing row (never inserts), so
      // a driver holding a pre-cancel snapshot can't resurrect the deleted run as a zombie —
      // proven identically on D1 and Postgres. (A blind `upsert` WOULD re-insert it, which is why
      // the durable driver's writes moved to `compareAndSwap`.)
      it('compareAndSwap never resurrects a deleted run (no zombie)', async () => {
        const app = harness.makeApp()
        const repo = app.executionRepository()
        const { workspace } = await app.createWorkspace()

        const base: ExecutionInstance = {
          id: 'exec_zombie',
          blockId: 'blk_zombie',
          pipelineId: 'pl',
          pipelineName: 'Pipeline',
          steps: [],
          currentStep: 0,
          status: 'running',
          initiatedBy: null,
        }
        await repo.upsert(workspace.id, base)
        // The durable driver loaded this snapshot (rev 0)…
        const driverSnapshot = await repo.get(workspace.id, 'exec_zombie')
        expect(driverSnapshot?.rev).toBe(0)

        // …then a human cancelled the run mid-poll (the row is deleted).
        await repo.deleteByBlock(workspace.id, 'blk_zombie')
        expect(await repo.get(workspace.id, 'exec_zombie')).toBeNull()

        // The driver's post-poll write lands on the now-absent row: refused, NO insert.
        driverSnapshot!.status = 'blocked'
        expect(await repo.compareAndSwap(workspace.id, driverSnapshot!)).toBe(false)
        // The run stays gone — not resurrected as a zombie `running` (or `blocked`) row.
        expect(await repo.get(workspace.id, 'exec_zombie')).toBeNull()
        expect(await repo.getByBlock(workspace.id, 'blk_zombie')).toBeNull()
      })

      // Race-audit 2.3: `markFailed` must not clobber a run that already reached a TERMINAL state.
      // A `stopRun` racing a run that just merged (`done`) reads a stale snapshot, so the SQL write
      // is the authoritative guard — `done`/`failed` rows are left untouched, so a merged task is
      // never re-marked `failed`. Proven identically on D1 and Postgres.
      it('markFailed refuses to re-fail a terminal (done) run', async () => {
        const app = harness.makeApp()
        const repo = app.executionRepository()
        const { workspace } = await app.createWorkspace()

        const merged: ExecutionInstance = {
          id: 'exec_done',
          blockId: 'blk_done',
          pipelineId: 'pl',
          pipelineName: 'Pipeline',
          steps: [],
          currentStep: 0,
          status: 'done',
          initiatedBy: null,
        }
        await repo.upsert(workspace.id, merged)

        await repo.markFailed(workspace.id, 'exec_done', {
          kind: 'cancelled',
          message: 'Stopped by the user.',
          detail: null,
          hint: null,
          occurredAt: 1,
          lastSubtasks: null,
        })
        // The done run is untouched — a just-merged task is not re-marked failed.
        expect((await repo.get(workspace.id, 'exec_done'))?.status).toBe('done')
      })

      // Race-audit 2.3 (the DRIVER-clobbers-terminal direction, dual of the guard above):
      // `markFailed` BUMPS `rev`, so an in-flight driver `casPersist` that loaded the run
      // BEFORE a `stopRun`/`failRun` can no longer resurrect it. Without the bump the terminal
      // write left `rev` untouched, so a stale `casPersist` writing a NON-terminal status
      // (a `pollGate` pending write, a dispatch write, …) would still MATCH the unchanged `rev`
      // and flip the stopped run back to `running`. Proven identically on D1 and Postgres.
      it('markFailed bumps rev so a stale driver write cannot resurrect a stopped run', async () => {
        const app = harness.makeApp()
        const repo = app.executionRepository()
        const { workspace } = await app.createWorkspace()

        const base: ExecutionInstance = {
          id: 'exec_stopped',
          blockId: 'blk_stopped',
          pipelineId: 'pl',
          pipelineName: 'Pipeline',
          steps: [],
          currentStep: 0,
          status: 'running',
          initiatedBy: null,
        }
        await repo.upsert(workspace.id, base)
        // The durable driver loaded this snapshot (rev 0) and is mid-probe…
        const driverSnapshot = await repo.get(workspace.id, 'exec_stopped')
        expect(driverSnapshot?.rev).toBe(0)

        // …then the human hit Stop: `failRun` → `markFailed` records the terminal failure.
        await repo.markFailed(workspace.id, 'exec_stopped', {
          kind: 'cancelled',
          message: 'Stopped by the user.',
          detail: null,
          hint: null,
          occurredAt: 1,
          lastSubtasks: null,
        })
        const stopped = await repo.get(workspace.id, 'exec_stopped')
        expect(stopped?.status).toBe('failed')
        // The terminal write bumped `rev`, so the driver's snapshot is now stale.
        expect(stopped?.rev).toBe(1)

        // The driver's post-probe write (a non-terminal `running`, from its pre-stop snapshot)
        // is refused — it holds the pre-fail rev, so the CAS misses.
        driverSnapshot!.status = 'running'
        expect(await repo.compareAndSwap(workspace.id, driverSnapshot!)).toBe(false)
        // The run stays failed — NOT resurrected as a zombie `running` row.
        expect((await repo.get(workspace.id, 'exec_stopped'))?.status).toBe('failed')
      })

      // Race-audit 2.2 controller-half: the gate-window CONTROLLERS (review incorporate/proceed,
      // human-test/visual-confirm/interview signal, companion resolve-exceeded) no longer blind-
      // upsert — they persist their human-action write through `RunStateMachine.mutateInstance`,
      // which on a lost race RELOADS the winning snapshot and RE-APPLIES its (pure) mutation so
      // BOTH edits survive, rather than the loser clobbering the winner (the last-write-wins bug).
      // This models that reload-and-retry at the repository layer, proven identically on D1 and
      // Postgres: a human action and the durable driver both load rev 0; the driver's write lands
      // first; the human's stale write is refused; it reloads and re-applies, and the run carries
      // BOTH mutations.
      it('mutateInstance-style reload-and-retry lands both a driver write and a racing human write', async () => {
        const app = harness.makeApp()
        const repo = app.executionRepository()
        const { workspace } = await app.createWorkspace()

        const base: ExecutionInstance = {
          id: 'exec_occ',
          blockId: 'blk_occ',
          pipelineId: 'pl',
          pipelineName: 'Pipeline',
          steps: [
            {
              agentKind: 'reviewer',
              state: 'waiting_decision',
              progress: 0,
              approval: { id: 'appr_occ', status: 'pending', proposal: '' },
            },
          ] as unknown as ExecutionInstance['steps'],
          currentStep: 0,
          status: 'blocked',
          initiatedBy: null,
        }
        await repo.upsert(workspace.id, base)

        // A human action (the controller) and the durable driver both load the same rev 0.
        const humanSnapshot = (await repo.get(workspace.id, 'exec_occ'))!
        const driverSnapshot = (await repo.get(workspace.id, 'exec_occ'))!
        expect(humanSnapshot.rev).toBe(0)
        expect(driverSnapshot.rev).toBe(0)

        // The driver's write lands first (e.g. a poll fold flipping the run back to `running`).
        driverSnapshot.status = 'running'
        expect(await repo.compareAndSwap(workspace.id, driverSnapshot)).toBe(true)

        // The human's write from the now-stale rev 0 is REFUSED — a blind upsert would have
        // reverted the driver's `running` back to `blocked` (the clobber this fix removes).
        humanSnapshot.steps[0]!.approval!.status = 'approved'
        expect(await repo.compareAndSwap(workspace.id, humanSnapshot)).toBe(false)

        // `mutateInstance` reloads the winning snapshot and re-applies the pure mutation.
        const reloaded = (await repo.get(workspace.id, 'exec_occ'))!
        expect(reloaded.status).toBe('running') // the driver's write survived
        reloaded.steps[0]!.approval!.status = 'approved'
        expect(await repo.compareAndSwap(workspace.id, reloaded)).toBe(true)

        // BOTH edits are present: the driver's status flip AND the human's approval.
        const settled = (await repo.get(workspace.id, 'exec_occ'))!
        expect(settled.status).toBe('running')
        expect(settled.steps[0]!.approval!.status).toBe('approved')
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

        // A LIVE run of a DIFFERENT kind (a bootstrap job stays `running` until driven) shares
        // the `agent_runs` table but must NOT leak into the execution projection — `listLive`
        // filters `kind = 'execution'`. Seed one via the real bootstrap route (the
        // FakeRepoBootstrapper reports connected, so the pre-flight passes) and leave it running.
        const bootstrap = await app.call<{ status: string }>(
          'POST',
          `/workspaces/${workspace.id}/bootstrap/jobs`,
          { repoName: 'listlive-kind-probe', instructions: 'Scaffold a small HTTP service.' },
        )
        expect(bootstrap.body.status).toBe('running')

        // `listLive` (workspace-scoped) returns the lean {id,blockId,status} projection of the
        // LIVE runs (running/blocked/paused) — never terminal, never a non-execution kind —
        // backing the dispatch guard + resumePaused. It maps block ids and carries status
        // without decoding `detail`.
        const liveRows = await execs.listLive(workspace.id)
        const liveById = new Map(liveRows.map((r) => [r.id, r]))
        expect(new Set(liveById.keys())).toEqual(
          new Set(['exec_sweep_running', 'exec_sweep_blocked', 'exec_sweep_paused']),
        )
        expect(liveById.get('exec_sweep_running')?.status).toBe('running')
        expect(liveById.get('exec_sweep_running')?.blockId).toBe('blk_exec_sweep_running')
        expect(liveById.get('exec_sweep_paused')?.status).toBe('paused')
        // A workspace with no live runs projects to an empty list.
        const emptyWs = await app.createWorkspace()
        expect(await execs.listLive(emptyWs.workspace.id)).toEqual([])
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

      it('serves the full task lifecycle (edit / stop / retry / rich run) + pipeline discovery, workspace-scoped', async () => {
        const { call, createOrgWorkspace, drive } = harness.makeApp()
        const { workspace } = await createOrgWorkspace({ seed: true })
        const wsId = workspace.id

        const created = await call<{ secret: string }>(
          'POST',
          `/workspaces/${wsId}/public-api-keys`,
          { label: 'external' },
        )
        expect(created.status).toBe(201)
        const auth = { authorization: `Bearer ${created.body.secret}` }

        // Pipeline discovery: the public inline pipeline is public + headless-startable; a
        // container pipeline (pl_quick) is listed but neither. Closes the "start demands a
        // pipelineId, nothing lists them" gap.
        const pipelines = await call<{
          pipelines: {
            pipelineId: string
            steps: string[]
            public: boolean
            headlessStartable: boolean
          }[]
        }>('GET', '/api/v1/pipelines', undefined, auth)
        expect(pipelines.status).toBe(200)
        const byId = new Map(pipelines.body.pipelines.map((p) => [p.pipelineId, p]))
        const breakdown = byId.get('pl_initiative_breakdown')
        expect(breakdown?.public).toBe(true)
        expect(breakdown?.headlessStartable).toBe(true)
        expect(breakdown && breakdown.steps.length > 0).toBe(true)
        const quick = byId.get('pl_quick')
        expect(quick).toBeTruthy()
        expect(quick?.headlessStartable).toBe(false)

        // Create a task under a fresh service frame (via the dev-open session board route).
        const frame = await call<{ id: string }>('POST', `/workspaces/${wsId}/blocks`, {
          type: 'service',
          position: { x: 500, y: 500 },
        })
        const task = await call<{ taskId: string }>(
          'POST',
          `/api/v1/services/${frame.body.id}/tasks`,
          { title: 'Lifecycle task', description: 'original' },
          auth,
        )
        expect(task.status).toBe(201)
        const taskId = task.body.taskId

        // Edit (PATCH) the title/description before it runs.
        const edited = await call<{ title: string; description: string }>(
          'PATCH',
          `/api/v1/tasks/${taskId}`,
          { title: 'Lifecycle task (edited)', description: 'reworded' },
          auth,
        )
        expect(edited.status).toBe(200)
        expect(edited.body.title).toBe('Lifecycle task (edited)')
        expect(edited.body.description).toBe('reworded')

        // A not-yet-started task has no run to read or stop.
        expect((await call('GET', `/api/v1/tasks/${taskId}/run`, undefined, auth)).status).toBe(404)
        expect((await call('POST', `/api/v1/tasks/${taskId}/stop`, undefined, auth)).status).toBe(
          409,
        )

        // Start it (async — left running until driven), then read the rich run projection.
        const started = await call<{ executionId: string | null }>(
          'POST',
          `/api/v1/tasks/${taskId}/start`,
          { pipelineId: 'pl_quick' },
          auth,
        )
        expect(started.status).toBe(202)
        const run = await call<{
          runId: string
          taskId: string
          status: string
          steps: { agentKind: string; state: string; progress: number }[]
        }>('GET', `/api/v1/tasks/${taskId}/run`, undefined, auth)
        expect(run.status).toBe(200)
        expect(run.body.taskId).toBe(taskId)
        expect(run.body.steps.length).toBeGreaterThan(0)
        expect(['running', 'blocked', 'paused', 'done']).toContain(run.body.status)

        // Stop the run → it settles `failed` with a `cancelled` error, and stays retryable.
        expect((await call('POST', `/api/v1/tasks/${taskId}/stop`, undefined, auth)).status).toBe(
          200,
        )
        const stopped = await call<{ status: string; error: { code: string } | null }>(
          'GET',
          `/api/v1/tasks/${taskId}/run`,
          undefined,
          auth,
        )
        expect(stopped.body.status).toBe('failed')
        expect(stopped.body.error?.code).toBe('cancelled')

        // Retry the failed run, then drive it to completion.
        expect((await call('POST', `/api/v1/tasks/${taskId}/retry`, undefined, auth)).status).toBe(
          202,
        )
        await drive(wsId)
        const finished = await call<{ status: string }>(
          'GET',
          `/api/v1/tasks/${taskId}/run`,
          undefined,
          auth,
        )
        expect(finished.body.status).toBe('done')

        // Every lifecycle route double-scopes to the key's workspace: a key from ANOTHER
        // workspace 404s on this task (never edits/stops/retries/reads it).
        const other = await createOrgWorkspace({ seed: true })
        const otherKey = await call<{ secret: string }>(
          'POST',
          `/workspaces/${other.workspace.id}/public-api-keys`,
          { label: 'other' },
        )
        const otherAuth = { authorization: `Bearer ${otherKey.body.secret}` }
        expect(
          (await call('GET', `/api/v1/tasks/${taskId}/run`, undefined, otherAuth)).status,
        ).toBe(404)
        expect(
          (await call('PATCH', `/api/v1/tasks/${taskId}`, { title: 'x' }, otherAuth)).status,
        ).toBe(404)
        expect(
          (await call('POST', `/api/v1/tasks/${taskId}/stop`, undefined, otherAuth)).status,
        ).toBe(404)
        expect(
          (await call('POST', `/api/v1/tasks/${taskId}/retry`, undefined, otherAuth)).status,
        ).toBe(404)
      })

      it('gates each route on the key scope ladder (read ⊂ write ⊂ admin) and deletes with admin', async () => {
        const { call, createOrgWorkspace } = harness.makeApp()
        const { workspace } = await createOrgWorkspace({ seed: true })
        const wsId = workspace.id

        // Mint one key per scope. An omitted scope defaults to `write`.
        const mint = async (scope: 'read' | 'write' | 'admin') => {
          const res = await call<{ key: { scope: string }; secret: string }>(
            'POST',
            `/workspaces/${wsId}/public-api-keys`,
            { label: scope, scope },
          )
          expect(res.status).toBe(201)
          expect(res.body.key.scope).toBe(scope)
          return { authorization: `Bearer ${res.body.secret}` }
        }
        const readAuth = await mint('read')
        const writeAuth = await mint('write')
        const adminAuth = await mint('admin')
        // The default (no scope in the body) is `write`.
        const defaulted = await call<{ key: { scope: string } }>(
          'POST',
          `/workspaces/${wsId}/public-api-keys`,
          { label: 'defaulted' },
        )
        expect(defaulted.body.key.scope).toBe('write')

        const frame = await call<{ id: string }>('POST', `/workspaces/${wsId}/blocks`, {
          type: 'service',
          position: { x: 400, y: 400 },
        })
        const serviceId = frame.body.id

        // A `read` key can read (list services) but is refused (403 insufficient_scope) on any
        // write — e.g. creating a task.
        expect((await call('GET', '/api/v1/services', undefined, readAuth)).status).toBe(200)
        const readCreate = await call<{ error: { code: string } }>(
          'POST',
          `/api/v1/services/${serviceId}/tasks`,
          { title: 'nope', description: 'x' },
          readAuth,
        )
        expect(readCreate.status).toBe(403)
        expect(readCreate.body.error.code).toBe('insufficient_scope')

        // A `write` key creates the task (and can read it) but is refused on the destructive DELETE.
        const created = await call<{ taskId: string }>(
          'POST',
          `/api/v1/services/${serviceId}/tasks`,
          { title: 'Scoped task', description: 'x' },
          writeAuth,
        )
        expect(created.status).toBe(201)
        const taskId = created.body.taskId
        expect((await call('GET', `/api/v1/tasks/${taskId}`, undefined, readAuth)).status).toBe(200)
        const writeDelete = await call<{ error: { code: string } }>(
          'DELETE',
          `/api/v1/tasks/${taskId}`,
          undefined,
          writeAuth,
        )
        expect(writeDelete.status).toBe(403)
        expect(writeDelete.body.error.code).toBe('insufficient_scope')
        // Still present after the refused delete.
        expect((await call('GET', `/api/v1/tasks/${taskId}`, undefined, readAuth)).status).toBe(200)

        // An `admin` key deletes it; the task is then gone (404) for every scope.
        expect((await call('DELETE', `/api/v1/tasks/${taskId}`, undefined, adminAuth)).status).toBe(
          204,
        )
        expect((await call('GET', `/api/v1/tasks/${taskId}`, undefined, readAuth)).status).toBe(404)
        // Deleting an already-gone task is idempotent-but-scoped: a real task no longer resolves,
        // so it 404s (never a 5xx) even for admin.
        expect((await call('DELETE', `/api/v1/tasks/${taskId}`, undefined, adminAuth)).status).toBe(
          404,
        )
      })

      it('serves the notification inbox (list / dismiss / act), scope-gated + workspace-scoped', async () => {
        const app = harness.makeApp()
        const { call, createOrgWorkspace } = app
        const { workspace } = await createOrgWorkspace({ seed: true })
        const wsId = workspace.id

        const mint = async (scope: 'read' | 'write' | 'admin') => {
          const res = await call<{ secret: string }>(
            'POST',
            `/workspaces/${wsId}/public-api-keys`,
            { label: scope, scope },
          )
          expect(res.status).toBe(201)
          return { authorization: `Bearer ${res.body.secret}` }
        }
        const readAuth = await mint('read')
        const writeAuth = await mint('write')
        const adminAuth = await mint('admin')

        // Seed OPEN notifications directly (the engine raises these mid-run; seeding the
        // persisted rows keeps the test targeted at the public routes, not the run machinery).
        // The actionable cards are `merge_review` with a null `blockId`: `act` admits the type
        // (it has an automated merge side-effect) but the null block short-circuits the merge, so
        // the card settles `acted` without needing a real block/run/PR.
        const seed = (id: string, type: 'merge_review' | 'requirement_review' = 'merge_review') =>
          app.notificationRepository().upsert(wsId, {
            id,
            type,
            status: 'open',
            severity: 'normal',
            blockId: null,
            executionId: null,
            title: id,
            body: 'body',
            payload: null,
            createdAt: 1,
            resolvedAt: null,
          })
        await seed('ntf_dismiss')
        await seed('ntf_act')

        // An informational card (`requirement_review`) — it parks a run on an interactive human
        // decision, so it has NO automated action and `act` must refuse it (→ dismiss instead).
        await seed('ntf_info', 'requirement_review')

        // list: a `read` key sees all three open cards.
        const listed = await call<{ notifications: { id: string; status: string }[] }>(
          'GET',
          '/api/v1/notifications',
          undefined,
          readAuth,
        )
        expect(listed.status).toBe(200)
        expect(new Set(listed.body.notifications.map((n) => n.id))).toEqual(
          new Set(['ntf_dismiss', 'ntf_act', 'ntf_info']),
        )

        // Scope ladder: a `read` key can't dismiss/act; a `write` key can dismiss but not act
        // (act performs a real merge → admin only).
        const readDismiss = await call<{ error: { code: string } }>(
          'POST',
          '/api/v1/notifications/ntf_dismiss/dismiss',
          undefined,
          readAuth,
        )
        expect(readDismiss.status).toBe(403)
        expect(readDismiss.body.error.code).toBe('insufficient_scope')
        const writeAct = await call<{ error: { code: string } }>(
          'POST',
          '/api/v1/notifications/ntf_act/act',
          undefined,
          writeAuth,
        )
        expect(writeAct.status).toBe(403)
        expect(writeAct.body.error.code).toBe('insufficient_scope')

        // dismiss (write) resolves the card as `dismissed`; act (admin) resolves it as `acted`.
        const dismissed = await call<{ status: string }>(
          'POST',
          '/api/v1/notifications/ntf_dismiss/dismiss',
          undefined,
          writeAuth,
        )
        expect(dismissed.status).toBe(200)
        expect(dismissed.body.status).toBe('dismissed')
        const acted = await call<{ status: string }>(
          'POST',
          '/api/v1/notifications/ntf_act/act',
          undefined,
          adminAuth,
        )
        expect(acted.status).toBe(200)
        expect(acted.body.status).toBe('acted')

        // `act` refuses an informational card (no automated action) with 409, even for an admin
        // key — it must be dismissed, not acted — while `dismiss` resolves it normally.
        const actInfo = await call<{ error: { code: string } }>(
          'POST',
          '/api/v1/notifications/ntf_info/act',
          undefined,
          adminAuth,
        )
        expect(actInfo.status).toBe(409)
        expect(actInfo.body.error.code).toBe('notification_not_actionable')
        const dismissInfo = await call<{ status: string }>(
          'POST',
          '/api/v1/notifications/ntf_info/dismiss',
          undefined,
          writeAuth,
        )
        expect(dismissInfo.status).toBe(200)
        expect(dismissInfo.body.status).toBe('dismissed')

        // All resolved, so the inbox is now empty (list is open-only).
        const after = await call<{ notifications: unknown[] }>(
          'GET',
          '/api/v1/notifications',
          undefined,
          readAuth,
        )
        expect(after.body.notifications).toEqual([])

        // Workspace-scoped: a key from ANOTHER workspace never sees or resolves this
        // workspace's notifications (an unknown/foreign id is a 404 on both act and dismiss).
        await seed('ntf_foreign')
        const other = await createOrgWorkspace({ seed: true })
        const otherKey = await call<{ secret: string }>(
          'POST',
          `/workspaces/${other.workspace.id}/public-api-keys`,
          { label: 'admin', scope: 'admin' },
        )
        const otherAuth = { authorization: `Bearer ${otherKey.body.secret}` }
        const otherList = await call<{ notifications: unknown[] }>(
          'GET',
          '/api/v1/notifications',
          undefined,
          otherAuth,
        )
        expect(otherList.body.notifications).toEqual([])
        expect(
          (await call('POST', '/api/v1/notifications/ntf_foreign/act', undefined, otherAuth))
            .status,
        ).toBe(404)
        expect(
          (await call('POST', '/api/v1/notifications/ntf_foreign/dismiss', undefined, otherAuth))
            .status,
        ).toBe(404)
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

      it('round-trips the per-step companion toggles (followUps + testerQuality) + stepOptions on every store', async () => {
        // The pipeline builder's two per-step companion toggles live on their own JSON columns
        // (D1/Drizzle `follow_ups` + `tester_quality`), so a custom pipeline that opts a Coder
        // step OUT of the Follow-up companion and configures a Tester step's QC companion (an
        // estimate gate) must survive the store round-trip identically — otherwise the builder
        // toggle silently reverts to the default on the next load. The newer extensible
        // per-step options bag (`step_options` — home of the requirements-review `autoRecommend`
        // toggle) rides the SAME symmetric-persistence contract and is asserted alongside them.
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const wsId = workspace.id

        const created = await call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Toggles',
          // The prose description rides the same symmetric-persistence contract (its own
          // `description` column on both stores) and must round-trip identically.
          description: 'A custom pipeline for the toggles test.',
          agentKinds: ['task-estimator', 'coder', 'tester-api'],
          // Coder opts out of the Follow-up companion; the Tester's QC companion is gated on the
          // task estimate (an estimator runs earlier, so the gate is valid).
          followUps: [null, false, null],
          testerQuality: [
            null,
            null,
            { enabled: true, gating: { enabled: true, minRisk: 0.6, onMissingEstimate: 'run' } },
          ],
          // A per-step options bag opting one step out of auto-recommendation — the extensible
          // seam that must round-trip through the single `step_options` column on both stores.
          stepOptions: [null, { autoRecommend: false }, null],
        })
        expect(created.status).toBe(201)
        expect(created.body.description).toBe('A custom pipeline for the toggles test.')
        expect(created.body.followUps?.[1]).toBe(false)
        expect(created.body.testerQuality?.[2]).toEqual({
          enabled: true,
          gating: { enabled: true, minRisk: 0.6, onMissingEstimate: 'run' },
        })
        expect(created.body.stepOptions?.[1]).toEqual({ autoRecommend: false })

        // A fresh snapshot read re-hydrates every column from the store, identically on D1 ⇄ Postgres.
        const snapshot = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        const stored = snapshot.body.pipelines.find((p) => p.id === created.body.id)!
        expect(stored.description).toBe('A custom pipeline for the toggles test.')
        expect(stored.followUps?.[1]).toBe(false)
        expect(stored.testerQuality?.[2]).toEqual({
          enabled: true,
          gating: { enabled: true, minRisk: 0.6, onMissingEstimate: 'run' },
        })
        expect(stored.stepOptions?.[1]).toEqual({ autoRecommend: false })
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

    describe('PR deep-review (pr-reviewer park → select → resolve)', () => {
      // The read-only pr-reviewer's structured findings, returned by the fake as `result.custom`.
      const reviewerOutput = {
        summary: 'Mostly solid; one correctness concern.',
        slices: [{ title: 'Auth', rationale: 'auth + its test', paths: ['src/auth.ts'] }],
        findings: [
          {
            path: 'src/auth.ts',
            line: 12,
            side: 'RIGHT',
            severity: 'high',
            category: 'correctness',
            title: 'Missing null guard',
            detail: 'The token may be undefined here.',
            suggestedFix: 'Guard before dereferencing.',
          },
          {
            path: 'README.md',
            severity: 'nit',
            category: 'style',
            title: 'Typo',
            detail: 'teh → the',
          },
        ],
      }

      it('parks a review run on its findings, then resolves the human selection to done', async () => {
        const { call, createWorkspace, drive } = harness.makeApp({ customResult: reviewerOutput })
        const { workspace } = await createWorkspace({ seed: true })
        const wsId = workspace.id

        // A review task defaults to the pl_review pipeline (a single read-only pr-reviewer step).
        const task = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
          title: 'Review PR #42',
          taskType: 'review',
          taskTypeFields: { prNumber: 42, prUrl: 'https://github.com/o/r/pull/42' },
        })
        expect(task.status).toBe(201)
        const start = await call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/${task.body.id}/executions`,
          { pipelineId: 'pl_review' },
        )
        expect(start.status).toBe(201)

        // Driving runs the reviewer; its findings are recorded onto the step and the run PARKS
        // for a human to select — it does NOT finish on its own.
        const parked = (await drive(wsId)).find((e) => e.blockId === task.body.id)!
        expect(parked.status).toBe('blocked')
        const step = parked.steps.find((s) => s.agentKind === 'pr-reviewer')!
        expect(step.prReview?.status).toBe('awaiting_selection')
        expect(step.prReview?.prUrl).toBe('https://github.com/o/r/pull/42')
        // Findings are id-stamped, severity-ordered (high before nit), and anchored to a slice.
        const findings = step.prReview?.findings ?? []
        expect(findings.map((f) => f.severity)).toEqual(['high', 'nit'])
        expect(findings[0]!.id).toMatch(/^prf_/)
        expect(findings[0]!.sliceId).toBe(step.prReview?.slices?.[0]?.id)

        // The park raised a `pr_review_ready` inbox card (identically on both runtimes).
        const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        expect(snap.body.notifications?.some((n) => n.type === 'pr_review_ready')).toBe(true)

        // The GET returns the same active state.
        const active = await call<PrReviewStepState>(
          'GET',
          `/workspaces/${wsId}/executions/${parked.id}/pr-review`,
        )
        expect(active.body.status).toBe('awaiting_selection')

        // Resolving with a curated selection records it and advances the read-only run to done.
        const resolved = await call<PrReviewStepState>(
          'POST',
          `/workspaces/${wsId}/executions/${parked.id}/pr-review/resolve`,
          { action: 'finish', findingIds: [findings[0]!.id] },
        )
        expect(resolved.status).toBe(200)
        expect(resolved.body.status).toBe('done')
        expect(resolved.body.selectedFindingIds).toEqual([findings[0]!.id])

        const done = (await drive(wsId)).find((e) => e.blockId === task.body.id)!
        expect(done.status).toBe('done')
        const finalBlock = (
          await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        ).body.blocks.find((b) => b.id === task.body.id)!
        expect(finalBlock.status).toBe('done')
      })

      // A checkout-free RepoFiles capturing the deep-review resolutions' VCS writes/reads (the
      // suite's stand-in for a facade's GitHubClient-backed RepoFiles) — no real GitHub needed.
      const makeReviewRepo = (
        recorder: {
          headRefFor?: number
          posted?: { number: number; input: CreateReviewInput }[]
        },
        headRef: string | null = 'feature/pr-42',
      ): RepoFiles => ({
        getFile: async () => null,
        listDirectory: async () => [],
        headSha: async () => 'base-sha',
        createBranch: async () => {},
        deleteBranch: async () => {},
        commitFiles: async () => ({ sha: 'commit-sha' }),
        openPullRequest: async () => {
          throw new Error('not exercised by this test')
        },
        pullRequestHeadRef: async (number) => {
          recorder.headRefFor = number
          return headRef
        },
        createReview: async (number, input) => {
          ;(recorder.posted ??= []).push({ number, input })
        },
      })

      const seedReviewTask = async (
        call: ConformanceApp['call'],
        drive: ConformanceApp['drive'],
        wsId: string,
      ) => {
        const task = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
          title: 'Review PR #42',
          taskType: 'review',
          taskTypeFields: { prNumber: 42, prUrl: 'https://github.com/o/r/pull/42' },
        })
        await call('POST', `/workspaces/${wsId}/blocks/${task.body.id}/executions`, {
          pipelineId: 'pl_review',
        })
        const parked = (await drive(wsId)).find((e) => e.blockId === task.body.id)!
        const step = parked.steps.find((s) => s.agentKind === 'pr-reviewer')!
        return {
          taskId: task.body.id,
          executionId: parked.id,
          findings: step.prReview?.findings ?? [],
        }
      }

      it('resolves with `fix` — re-dispatches the step as a Fixer on the reviewed PR head branch', async () => {
        const recorder: { headRefFor?: number } = {}
        const { call, createWorkspace, drive } = harness.makeApp(
          { customResult: reviewerOutput },
          {
            resolveRunRepoContext: async () => ({
              repo: makeReviewRepo(recorder),
              baseBranch: 'main',
            }),
          },
        )
        const { workspace } = await createWorkspace({ seed: true })
        const wsId = workspace.id
        const { taskId, executionId, findings } = await seedReviewTask(call, drive, wsId)

        // Resolve with `fix`, selecting the blocker finding — re-arms the step to `fixing`.
        const resolved = await call<PrReviewStepState>(
          'POST',
          `/workspaces/${wsId}/executions/${executionId}/pr-review/resolve`,
          { action: 'fix', findingIds: [findings[0]!.id] },
        )
        expect(resolved.status).toBe(200)
        expect(resolved.body.status).toBe('fixing')
        expect(resolved.body.resolution).toBe('fix')

        // Driving dispatches + completes the Fixer against the PR head branch, then finishes.
        const done = (await drive(wsId)).find((e) => e.blockId === taskId)!
        expect(done.status).toBe('done')
        const finalStep = done.steps.find((s) => s.agentKind === 'pr-reviewer')!
        expect(finalStep.prReview?.status).toBe('done')
        expect(finalStep.prReview?.resolution).toBe('fix')
        // The Fixer resolved PR #42's head branch to clone + push to (a review task has no own PR).
        expect(recorder.headRefFor).toBe(42)
      })

      it('resolves with `post` — publishes the selected findings as inline PR review comments', async () => {
        const recorder: { posted?: { number: number; input: CreateReviewInput }[] } = {}
        const { call, createWorkspace, drive } = harness.makeApp(
          { customResult: reviewerOutput },
          {
            resolveRunRepoContext: async () => ({
              repo: makeReviewRepo(recorder),
              baseBranch: 'main',
            }),
          },
        )
        const { workspace } = await createWorkspace({ seed: true })
        const wsId = workspace.id
        const { taskId, executionId, findings } = await seedReviewTask(call, drive, wsId)

        // Resolve with `post`, selecting BOTH findings (one anchored, one line-less).
        const resolved = await call<PrReviewStepState>(
          'POST',
          `/workspaces/${wsId}/executions/${executionId}/pr-review/resolve`,
          { action: 'post', findingIds: findings.map((f) => f.id) },
        )
        expect(resolved.status).toBe(200)
        expect(resolved.body.status).toBe('posting')

        // Driving posts a single advisory review + finishes the read-only run.
        const done = (await drive(wsId)).find((e) => e.blockId === taskId)!
        expect(done.status).toBe('done')
        const finalStep = done.steps.find((s) => s.agentKind === 'pr-reviewer')!
        expect(finalStep.prReview?.status).toBe('done')
        expect(finalStep.prReview?.resolution).toBe('post')

        // Exactly one COMMENT review, to PR #42, with the anchored finding as an inline comment.
        expect(recorder.posted).toHaveLength(1)
        expect(recorder.posted![0]!.number).toBe(42)
        expect(recorder.posted![0]!.input.event).toBe('COMMENT')
        expect(
          recorder.posted![0]!.input.comments.some(
            (c) => c.path === 'src/auth.ts' && c.line === 12,
          ),
        ).toBe(true)
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

        // Setting a per-workspace budget must take effect immediately — the initial GET
        // warmed the shared `workspaceSettings` cache slice (which SpendService's pricing
        // overlay reads through), and the settings write invalidates it — and round-trip
        // through the workspace_settings columns identically on both stores.
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

      it('counts subscription usage in /usage but excludes it from the spend budget (D1 ⇄ Postgres)', async () => {
        type UsageRow = {
          billing: string
          vendor: string | null
          provider: string
          model: string
          inputTokens: number
          outputTokens: number
          costEstimate: number
          calls: number
        }
        type UsageReport = { periodStart: number; currency: string; rows: UsageRow[] }
        type Spend = { inputTokens: number; outputTokens: number; costSpent: number }

        // A subscription-harness run: the fake reports usage tagged 'subscription' (vendor
        // claude) — the proxy-bypassing Claude Code / Codex path.
        const sub = harness.makeApp({
          usage: { inputTokens: 1000, outputTokens: 500 },
          usageBilling: 'subscription',
          usageVendor: 'claude',
        })
        const subWs = (await sub.createWorkspace()).workspace.id
        const subPipe = await sub.call<Pipeline>('POST', `/workspaces/${subWs}/pipelines`, {
          name: 'Code',
          agentKinds: ['coder'],
        })
        const subStart = await sub.call(
          'POST',
          `/workspaces/${subWs}/blocks/task_login/executions`,
          {
            pipelineId: subPipe.body.id,
          },
        )
        expect(subStart.status).toBe(201)
        await sub.drive(subWs)

        const subUsage = await sub.call<UsageReport>('GET', `/workspaces/${subWs}/usage`)
        expect(subUsage.status).toBe(200)
        const subRow = subUsage.body.rows.find((r) => r.billing === 'subscription')
        expect(subRow).toBeDefined()
        expect(subRow?.vendor).toBe('claude')
        expect(subRow?.inputTokens).toBeGreaterThanOrEqual(1000)
        // The load-bearing invariant: a flat-rate subscription call is counted in the report
        // but NEVER in the spend budget (a quota plan costs nothing per token).
        expect(subUsage.body.rows.every((r) => r.billing === 'subscription')).toBe(true)
        const subSpend = await sub.call<Spend>('GET', `/workspaces/${subWs}/spend`)
        expect(subSpend.body.inputTokens).toBe(0)
        expect(subSpend.body.costSpent).toBe(0)

        // A metered run (same usage, default billing) IS counted by both the report and the budget.
        const met = harness.makeApp({ usage: { inputTokens: 1000, outputTokens: 500 } })
        const metWs = (await met.createWorkspace()).workspace.id
        const metPipe = await met.call<Pipeline>('POST', `/workspaces/${metWs}/pipelines`, {
          name: 'Code',
          agentKinds: ['coder'],
        })
        const metStart = await met.call(
          'POST',
          `/workspaces/${metWs}/blocks/task_login/executions`,
          {
            pipelineId: metPipe.body.id,
          },
        )
        expect(metStart.status).toBe(201)
        await met.drive(metWs)

        const metSpend = await met.call<Spend>('GET', `/workspaces/${metWs}/spend`)
        expect(metSpend.body.inputTokens).toBeGreaterThanOrEqual(1000)
        const metUsage = await met.call<UsageReport>('GET', `/workspaces/${metWs}/usage`)
        expect(metUsage.body.rows.some((r) => r.billing === 'metered')).toBe(true)
      })

      it('surfaces a spend-paused run as a workspace-scoped budget_paused card, cleared on resume (D1 ⇄ Postgres)', async () => {
        // F3 (stuck-run audit): a spend-`paused` run is invisible to the sweeper and has no
        // auto-resume, so the paused board badge used to be its ONLY signal. The pause must now
        // raise ONE workspace-scoped inbox card (persisted on whichever store the runtime uses),
        // and lifting the pause via /spend/resume must clear it — asserted on both D1 and Postgres.
        type Notif = { id: string; type: string; blockId: string | null; status: string }
        const app = harness.makeApp({ usage: { inputTokens: 1000, outputTokens: 500 } })
        const wsId = (await app.createWorkspace()).workspace.id

        // A tiny positive budget: the run STARTS (0 spend is within budget, so the up-front
        // start guard allows it) but the first metered step's usage pushes cumulative cost over
        // the limit, so the SECOND step pauses mid-run — the exact state the sweeper can't see.
        expect(
          (await app.call('PUT', `/workspaces/${wsId}/settings`, { spendMonthlyLimit: 0.0001 }))
            .status,
        ).toBe(200)

        const pipe = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Code',
          agentKinds: ['coder', 'documenter'],
        })
        const started = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipe.body.id,
        })
        expect(started.status).toBe(201)
        const driven = await app.drive(wsId)
        expect(driven.find((e) => e.blockId === 'task_login')?.status).toBe('paused')

        // Exactly one workspace-scoped (block-less) budget_paused card, open.
        const inbox = await app.call<Notif[]>('GET', `/workspaces/${wsId}/notifications`)
        const budget = inbox.body.filter((n) => n.type === 'budget_paused')
        expect(budget).toHaveLength(1)
        expect(budget[0]!.blockId).toBeNull()
        expect(budget[0]!.status).toBe('open')

        // Raise the budget and resume: the card is cleared and the run advances off `paused`.
        expect(
          (await app.call('PUT', `/workspaces/${wsId}/settings`, { spendMonthlyLimit: 1000 }))
            .status,
        ).toBe(200)
        expect((await app.call('POST', `/workspaces/${wsId}/spend/resume`)).status).toBe(200)
        const resumed = await app.drive(wsId)
        expect(resumed.find((e) => e.blockId === 'task_login')?.status).not.toBe('paused')

        const after = await app.call<Notif[]>('GET', `/workspaces/${wsId}/notifications`)
        expect(after.body.some((n) => n.type === 'budget_paused' && n.status === 'open')).toBe(
          false,
        )
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

      it("round-trips a task's apriori branches (the JSON column) on every store", async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()
        const wsId = workspace.id

        // `aprioriBranches` is a task-level JSON column carrying the pre-existing branches handed
        // to the run (one optional `working` branch + any `reference` branches). BoardService
        // validates the cross-entry invariants and drops it on non-task blocks; a runtime that
        // forgot to map the column drops it on write, so this checks it survives PATCH + a fresh
        // snapshot read, and that clearing writes NULL (an empty array comes back absent).
        const task = await call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
          title: 'Continue the spike branch',
        })
        expect(task.status).toBe(201)
        const taskId = task.body.id

        const aprioriBranches = [
          { name: 'feature/checkout-v2', mode: 'working' as const },
          { name: 'spike/payments', mode: 'reference' as const },
        ]
        const set = await call<Block>('PATCH', `/workspaces/${wsId}/blocks/${taskId}`, {
          aprioriBranches,
        })
        expect(set.status).toBe(200)
        expect(set.body.aprioriBranches).toEqual(aprioriBranches)

        const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        expect(snap.body.blocks.find((b) => b.id === taskId)?.aprioriBranches).toEqual(
          aprioriBranches,
        )

        // Two working entries are rejected at the write boundary (single-working invariant).
        const twoWorking = await call<Block>('PATCH', `/workspaces/${wsId}/blocks/${taskId}`, {
          aprioriBranches: [
            { name: 'a', mode: 'working' },
            { name: 'b', mode: 'working' },
          ],
        })
        expect(twoWorking.status).toBe(422)

        // An unsafe git ref name is rejected by the contract schema (400, not the 422 write
        // boundary) — a value that would break the harness fetch/checkout never persists.
        const unsafe = await call<Block>('PATCH', `/workspaces/${wsId}/blocks/${taskId}`, {
          aprioriBranches: [{ name: 'bad name~with^stuff', mode: 'reference' }],
        })
        expect(unsafe.status).toBe(400)

        // Clearing with an empty array writes NULL, so the field comes back absent.
        const cleared = await call<Block>('PATCH', `/workspaces/${wsId}/blocks/${taskId}`, {
          aprioriBranches: [],
        })
        expect(cleared.status).toBe(200)
        expect(cleared.body.aprioriBranches).toBeUndefined()
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

      it('claimForAction atomically flips open→acted exactly once (act double-fire guard)', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id
        const repo = app.notificationRepository()
        const card: Notification = {
          id: 'ntf_act',
          type: 'merge_review',
          status: 'open',
          severity: 'normal',
          blockId: null,
          executionId: null,
          title: 'merge?',
          body: 'body',
          payload: null,
          createdAt: 1_000,
          resolvedAt: null,
        }
        await repo.upsert(wsId, card)

        // Two concurrent claims race the conditional UPDATE; exactly one wins the flip and
        // gets the row back (its side effect would run), the other is handed null and skips it.
        const [a, b] = await Promise.all([
          repo.claimForAction(wsId, 'ntf_act', 5_000),
          repo.claimForAction(wsId, 'ntf_act', 6_000),
        ])
        const winners = [a, b].filter((n) => n !== null)
        expect(winners).toHaveLength(1)
        expect(winners[0]?.status).toBe('acted')

        // The card is now acted; a later claim (or a re-click) finds it non-open → null.
        const persisted = await repo.get(wsId, 'ntf_act')
        expect(persisted?.status).toBe('acted')
        expect(persisted?.resolvedAt).toBe(winners[0]?.resolvedAt)
        expect(await repo.claimForAction(wsId, 'ntf_act', 7_000)).toBeNull()
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
