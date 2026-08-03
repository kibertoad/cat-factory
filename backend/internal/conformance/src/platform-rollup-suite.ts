import type { PlatformMetricsRepository } from '@cat-factory/kernel'
import { expect, it } from 'vitest'
import type { PlatformMetricsSeed } from './platform-metrics-suite.js'

// The DAILY-ROLLUP and FAILING-RUN-SAMPLE half of the platform-metrics parity suite, split out
// of `platform-metrics-suite.ts` when the two together outgrew the per-function line budget
// (budgets are split triggers, never numbers to raise). Registered as cases INSIDE that suite's
// `describe`, so a runtime still wires exactly one `definePlatformMetricsSuite` call and the
// cases stay grouped under the same heading.

/** Mints the unique account/workspace id pair each case is isolated by. */
type MakeIds = () => { account: string; ws: string }

export function defineRunDayAndFailureCases(
  makeRepo: () => PlatformMetricsRepository,
  makeSeed: () => PlatformMetricsSeed,
  ids: MakeIds,
): void {
  // ---- daily rollup (the `30d` / `90d` windows' source) --------------------
  // Each facade materialises the rollup in its own dialect's `INSERT … SELECT … GROUP BY`
  // (`CAST(created_at / ? AS INTEGER)` versus integer division on a bigint, `json_extract`
  // versus `->>`), so a day boundary that lands differently, or a failure kind extracted
  // differently, fails here rather than shipping as a `90d` dashboard that disagrees with
  // the `7d` one beside it.

  it('materialises daily buckets split by status and failure kind, scoped to the account', async () => {
    const repo = makeRepo()
    const seed = makeSeed()
    const { account, ws } = ids()
    const other = ids()
    await seed.workspace(ws, account)
    await seed.workspace(other.ws, other.account)
    const day = 24 * 60 * 60_000
    // Two runs on day 10, one on day 11, plus a neighbouring account's run on day 10.
    await seed.run({
      workspaceId: ws,
      id: `${ws}-d1`,
      kind: 'execution',
      status: 'done',
      createdAt: 10 * day + 1_000,
      updatedAt: 10 * day + 2_000,
    })
    await seed.run({
      workspaceId: ws,
      id: `${ws}-d2`,
      kind: 'execution',
      status: 'failed',
      createdAt: 10 * day + 3_000,
      updatedAt: 10 * day + 4_000,
      failureKind: 'evicted',
    })
    await seed.run({
      workspaceId: ws,
      id: `${ws}-d3`,
      kind: 'execution',
      status: 'failed',
      createdAt: 11 * day + 1_000,
      updatedAt: 11 * day + 2_000,
    })
    await seed.run({
      workspaceId: other.ws,
      id: `${other.ws}-d1`,
      kind: 'execution',
      status: 'done',
      createdAt: 10 * day + 5_000,
      updatedAt: 10 * day + 6_000,
    })

    await repo.rollupRunDays(10 * day, 12 * day)
    const rows = await repo.dailyRunTotalsSince(account, 10 * day)
    const byKey = new Map(
      rows.map((r) => [`${r.dayStart}/${r.status}/${r.failureKind ?? '-'}`, r.count]),
    )
    expect(byKey.get(`${10 * day}/done/-`)).toBe(1)
    expect(byKey.get(`${10 * day}/failed/evicted`)).toBe(1)
    // A failed run with no failure JSON rolls up as `unknown`, matching the live breakdown.
    expect(byKey.get(`${11 * day}/failed/unknown`)).toBe(1)
    // A non-failed bucket carries NO failure kind: the '' sentinel the key column needs is
    // mapped back to null at the read boundary, identically on both dialects.
    expect(rows.find((r) => r.status === 'done')?.failureKind).toBeNull()
    // The neighbouring account's run never leaks in.
    expect(rows.reduce((n, r) => n + r.count, 0)).toBe(3)
  })

  it('rewrites a still-accruing day in place rather than appending to it', async () => {
    // The current day's counts are not final, so a second pass must CORRECT the bucket. An
    // append (or a DO NOTHING) would freeze the day at whatever the first pass saw, and the
    // frozen value would then look exactly like a complete day.
    const repo = makeRepo()
    const seed = makeSeed()
    const { account, ws } = ids()
    await seed.workspace(ws, account)
    const day = 24 * 60 * 60_000
    await seed.run({
      workspaceId: ws,
      id: `${ws}-p1`,
      kind: 'execution',
      status: 'done',
      createdAt: 20 * day + 1_000,
      updatedAt: 20 * day + 2_000,
    })
    await repo.rollupRunDays(20 * day, 21 * day)
    await seed.run({
      workspaceId: ws,
      id: `${ws}-p2`,
      kind: 'execution',
      status: 'done',
      createdAt: 20 * day + 5_000,
      updatedAt: 20 * day + 6_000,
    })
    await repo.rollupRunDays(20 * day, 21 * day)

    const rows = await repo.dailyRunTotalsSince(account, 20 * day)
    expect(rows.filter((r) => r.dayStart === 20 * day && r.status === 'done')).toHaveLength(1)
    expect(rows.find((r) => r.dayStart === 20 * day && r.status === 'done')?.count).toBe(2)
  })

  it('reports the rollup watermark, and null before anything is materialised', async () => {
    const repo = makeRepo()
    const seed = makeSeed()
    const { account, ws } = ids()
    await seed.workspace(ws, account)
    const day = 24 * 60 * 60_000
    // NULL is the honest answer here and the reason the watermark is its own read: an account
    // with runs but no rollup, and one with neither, both return an empty series.
    expect(await repo.dailyRollupWatermark(account)).toBeNull()
    await seed.run({
      workspaceId: ws,
      id: `${ws}-w1`,
      kind: 'execution',
      status: 'done',
      createdAt: 30 * day + 1_000,
      updatedAt: 30 * day + 2_000,
    })
    await repo.rollupRunDays(30 * day, 31 * day)
    expect(await repo.dailyRollupWatermark(account)).toBe(30 * day)
  })

  it('prunes rolled-up days older than the cutoff', async () => {
    const repo = makeRepo()
    const seed = makeSeed()
    const { account, ws } = ids()
    await seed.workspace(ws, account)
    const day = 24 * 60 * 60_000
    await seed.run({
      workspaceId: ws,
      id: `${ws}-old`,
      kind: 'execution',
      status: 'done',
      createdAt: 40 * day + 1_000,
      updatedAt: 40 * day + 2_000,
    })
    await seed.run({
      workspaceId: ws,
      id: `${ws}-new`,
      kind: 'execution',
      status: 'done',
      createdAt: 42 * day + 1_000,
      updatedAt: 42 * day + 2_000,
    })
    await repo.rollupRunDays(40 * day, 43 * day)
    await repo.deleteRunDaysOlderThan(41 * day)
    const rows = await repo.dailyRunTotalsSince(account, 0)
    expect(rows.map((r) => r.dayStart)).toEqual([42 * day])
  })

  // ---- failing-run deep-link sample ---------------------------------------

  it('samples the newest failed EXECUTION runs per workspace, with each workspace total', async () => {
    const repo = makeRepo()
    const seed = makeSeed()
    const { account, ws } = ids()
    const second = `${ws}-b`
    await seed.workspace(ws, account)
    await seed.workspace(second, account)
    for (const [i, id] of ['f1', 'f2', 'f3'].entries()) {
      await seed.run({
        workspaceId: ws,
        id: `${ws}-${id}`,
        kind: 'execution',
        status: 'failed',
        createdAt: 5_000 + i,
        updatedAt: 5_100 + i,
        failureKind: 'agent',
      })
    }
    // A bootstrap failure has no run window to open, so it must never appear in the sample.
    await seed.run({
      workspaceId: ws,
      id: `${ws}-boot`,
      kind: 'bootstrap',
      status: 'failed',
      createdAt: 5_500,
      updatedAt: 5_600,
      failureKind: 'agent',
    })
    await seed.run({
      workspaceId: second,
      id: `${second}-f1`,
      kind: 'execution',
      status: 'failed',
      createdAt: 5_000,
      updatedAt: 5_100,
    })

    const sample = await repo.recentFailedRuns(account, 1_000, 2)
    // The cap is PER WORKSPACE, so the quiet workspace still gets its own evidence.
    const first = sample.filter((r) => r.workspaceId === ws)
    expect(first).toHaveLength(2)
    expect(first.map((r) => r.executionId)).toEqual([`${ws}-f3`, `${ws}-f2`])
    // Each row carries the workspace's FULL failed count, so the cap can say what it dropped.
    expect(first[0]?.workspaceFailedTotal).toBe(3)
    const other = sample.filter((r) => r.workspaceId === second)
    expect(other).toHaveLength(1)
    expect(other[0]?.failureKind).toBe('unknown')
    expect(other[0]?.workspaceFailedTotal).toBe(1)
  })
}
