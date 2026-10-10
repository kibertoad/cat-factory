import { type ExecutionInstance } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

// Core conformance, slice 2: the execution-run persistence primitives — optimistic-concurrency
// (compareAndSwap) upserts, the one-live-run-per-block insertLive guard, and the agent_runs
// sweeper read primitives. Split out of the former monolithic `core.ts`; re-opens its `describe`
// groups inside the aggregator's `[name] conformance` wrapper (test tree unchanged).
export function defineCoreRunsConformance(harness: ConformanceHarness): void {
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

  registerLiveRunInvariantTests(harness)
}

/**
 * The one-live-run-per-block invariant (with its replaceId supersede for retry/restart) and
 * the stale-run sweeper's read primitives.
 *
 * Registered from the suite above; split out purely to keep each function within the
 * per-function line budget. Every test is unchanged.
 */
function registerLiveRunInvariantTests(harness: ConformanceHarness): void {
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
    it('tracks a per-run re-drive count that survives the process that did the re-driving', async () => {
      // The sweeper's in-memory orphan map dies with the process on Node and with the isolate on
      // Cloudflare, and the Worker's sweep logs only aggregates with no run ids — so "was this
      // run re-driven three times?" had no answer anywhere before this column.
      const app = harness.makeApp()
      const runs = app.agentRunRepository()
      const { workspace } = await app.createWorkspace()
      await app.executionRepository().upsert(workspace.id, {
        id: 'exec_redrive',
        blockId: 'blk_redrive',
        pipelineId: 'pl',
        pipelineName: 'Pipeline',
        steps: [],
        currentStep: 0,
        status: 'running',
        initiatedBy: null,
      })

      // `listStale` is the sweeper's CROSS-WORKSPACE read, so it also returns identically-named
      // runs this suite created under earlier workspaces. Match on the workspace too, or the
      // assertion reads whichever `exec_redrive` came first and only passes against a database
      // nothing has run before — a pass that depends on CI provisioning a fresh Postgres.
      const ours = (rows: Awaited<ReturnType<typeof runs.listStale>>) =>
        rows.find((r) => r.id === 'exec_redrive' && r.workspaceId === workspace.id)

      // A run nobody has re-driven reads 0, not null/undefined: the sweeper compares it, and a
      // nullish value would silently disable the comparison on whichever facade produced it.
      expect(ours(await runs.listStale(Date.now() + 60_000))?.redriveCount).toBe(0)

      // `recordRedrive` increments and returns the NEW total in one statement, so nothing races
      // between a read and a write.
      expect(await runs.recordRedrive(workspace.id, 'exec_redrive')).toBe(1)
      expect(await runs.recordRedrive(workspace.id, 'exec_redrive')).toBe(2)
      expect(ours(await runs.listStale(Date.now() + 60_000))?.redriveCount).toBe(2)

      // A run that has since vanished answers 0 rather than throwing: this is bookkeeping ABOUT
      // a recovery and must never be able to fail one.
      expect(await runs.recordRedrive(workspace.id, 'exec_redrive_missing')).toBe(0)
    })

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

      // `countActiveByWorkspace` is run admission control's capacity read: the SQL-COUNT form of
      // the SAME live set `listLive` projects (docs/initiatives/run-admission-control.md). Both
      // queries read the shared `LIVE_EXECUTION_STATUSES`, so the status list itself cannot
      // drift; what this pins is the REST of each predicate agreeing on both stores — the `kind`
      // scope, the workspace scope, and (on D1) the interpolated IN list. They are asserted
      // against EACH OTHER because a cap checked against a count that disagrees with the runs
      // the board shows as live is worse than no cap at all: it would queue runs the workspace
      // has capacity for, or admit runs past it, with no visible cause. So terminal rows
      // (done/failed) and the live BOOTSTRAP job seeded above must both be outside it.
      //
      // NOTE for slice 2: this equality is expected to BREAK when `queued` lands, and the fix is
      // not to make the count include queued runs (nothing would ever be promoted) — it is to
      // split the two sets and assert each. See the initiative's gotchas.
      expect(await execs.countActiveByWorkspace(workspace.id)).toBe(3)
      expect(await execs.countActiveByWorkspace(workspace.id)).toBe(liveRows.length)
      // A workspace with nothing live counts zero, never null/undefined — the admission check
      // compares it numerically against a cap.
      expect(await execs.countActiveByWorkspace(emptyWs.workspace.id)).toBe(0)
    })
  })
}
