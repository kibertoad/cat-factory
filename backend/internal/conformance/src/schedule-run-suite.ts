import type { PipelineScheduleRepository, ScheduleRun } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the recurring-pipeline run history (`pipeline_schedule_runs`,
// the per-fire log surfaced in the inspector). Each facade persists it in its own store (D1
// on Cloudflare, Postgres via Drizzle on Node). This suite drives the SAME insert → patch →
// list (newest-first) → retention prune assertions through whichever real repository a
// runtime hands it, so a column mapped differently or a prune predicate built differently
// fails a test instead of shipping. The run history is retained ~1 week, so `pruneRunsBefore`
// is the only thing that reclaims it: it must delete runs started strictly before the cutoff.

function run(
  overrides: Partial<ScheduleRun> & Pick<ScheduleRun, 'id' | 'scheduleId'>,
): ScheduleRun {
  return {
    executionId: null,
    status: 'running',
    startedAt: 1_000,
    finishedAt: null,
    outcome: null,
    ...overrides,
  }
}

/**
 * Assert a runtime's {@link PipelineScheduleRepository} run-history behaviour is identical
 * across facades. `makeRepo` returns a repo over the runtime's real store; workspace/schedule
 * ids are unique per case so the shared database stays isolated between cases.
 */
export function defineScheduleRunSuite(
  name: string,
  makeRepo: () => PipelineScheduleRepository,
): void {
  describe(`[${name}] pipeline schedule-run repository parity`, () => {
    let seq = 0
    const scope = () => {
      seq += 1
      const tag = `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
      return { ws: `ws-${tag}`, schedule: `sch-${tag}` }
    }

    it('records runs, lists them newest-first, and patches a run in place', async () => {
      const repo = makeRepo()
      const { ws, schedule } = scope()
      await repo.insertRun(ws, run({ id: `${schedule}-1`, scheduleId: schedule, startedAt: 1_000 }))
      await repo.insertRun(
        ws,
        run({ id: `${schedule}-2`, scheduleId: schedule, startedAt: 5_000, status: 'done' }),
      )

      expect((await repo.listRuns(ws, schedule)).map((r) => r.id)).toEqual([
        `${schedule}-2`,
        `${schedule}-1`,
      ])

      await repo.updateRun(ws, `${schedule}-1`, {
        status: 'done',
        finishedAt: 2_000,
        outcome: 'merged',
        executionId: 'exec-1',
      })
      const patched = (await repo.listRuns(ws, schedule)).find((r) => r.id === `${schedule}-1`)!
      expect(patched).toMatchObject({
        status: 'done',
        finishedAt: 2_000,
        outcome: 'merged',
        executionId: 'exec-1',
      })
    })

    it('scopes the run list to (workspace, schedule)', async () => {
      const repo = makeRepo()
      const { ws, schedule } = scope()
      const other = scope()
      await repo.insertRun(ws, run({ id: `${schedule}-1`, scheduleId: schedule }))
      await repo.insertRun(other.ws, run({ id: `${other.schedule}-1`, scheduleId: other.schedule }))
      expect((await repo.listRuns(ws, schedule)).map((r) => r.id)).toEqual([`${schedule}-1`])
    })

    it('prunes runs started before the cutoff (exclusive), keeping newer ones', async () => {
      const repo = makeRepo()
      const { ws, schedule } = scope()
      await repo.insertRun(
        ws,
        run({ id: `${schedule}-old`, scheduleId: schedule, startedAt: 1_000 }),
      )
      await repo.insertRun(
        ws,
        run({ id: `${schedule}-new`, scheduleId: schedule, startedAt: 5_000 }),
      )
      // Exactly ON the cutoff: the prune is exclusive (`started_at < cutoff`), so this must
      // SURVIVE — a facade drifted to `<=` would delete it and fail here.
      await repo.insertRun(
        ws,
        run({ id: `${schedule}-edge`, scheduleId: schedule, startedAt: 2_000 }),
      )
      // Table-wide prune, so its count can include other cases' rows in the shared DB —
      // assert the scoped, deterministic survivors instead.
      const removed = await repo.pruneRunsBefore(2_000)
      expect(removed).toBeGreaterThanOrEqual(1)
      // Newest-first: `new` (5000) then the surviving edge row (2000); `old` (1000) gone.
      expect((await repo.listRuns(ws, schedule)).map((r) => r.id)).toEqual([
        `${schedule}-new`,
        `${schedule}-edge`,
      ])
    })
  })
}
