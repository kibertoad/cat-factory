import type { PlatformMetricsRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the deployment-level (platform-operator) rollups over
// `agent_runs`. Each facade aggregates in its own SQL dialect (D1/SQLite vs
// Postgres), so this suite seeds the SAME rows through a runtime-provided raw seed
// seam (the repository itself is read-only) and asserts the aggregates agree — a
// GROUP BY built differently, a JSON extraction that diverges, or an off-by-one
// window bound fails a test instead of shipping. Every case uses a UNIQUE account
// id so the account-scoped queries stay isolated on a shared database.

/** A single `agent_runs` row to seed. `failureKind` writes the JSON `failure` column. */
export interface PlatformMetricsSeedRun {
  workspaceId: string
  id: string
  kind: string
  status: string
  createdAt: number
  updatedAt: number
  /** When set, `failure` is `{"kind": failureKind, ...}`; when omitted, `failure` is NULL. */
  failureKind?: string
}

/** Raw seed seam a runtime implements against its real store (no domain write path needed). */
export interface PlatformMetricsSeed {
  /** Insert a workspace owned by `accountId` (idempotent per id). */
  workspace(id: string, accountId: string): Promise<void>
  /** Insert one `agent_runs` row. */
  run(row: PlatformMetricsSeedRun): Promise<void>
}

export function definePlatformMetricsSuite(
  name: string,
  makeRepo: () => PlatformMetricsRepository,
  makeSeed: () => PlatformMetricsSeed,
): void {
  describe(`[${name}] platform metrics repository parity`, () => {
    let seq = 0
    const ids = () => {
      seq += 1
      const tag = `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
      return { account: `acc-${tag}`, ws: `ws-${tag}` }
    }

    it('groups run outcomes by kind + status within the window and scopes to the account', async () => {
      const repo = makeRepo()
      const seed = makeSeed()
      const { account, ws } = ids()
      const other = ids()
      await seed.workspace(ws, account)
      await seed.workspace(other.ws, other.account)
      // In-window rows for the account.
      await seed.run({
        workspaceId: ws,
        id: `${ws}-1`,
        kind: 'execution',
        status: 'done',
        createdAt: 2_000,
        updatedAt: 2_500,
      })
      await seed.run({
        workspaceId: ws,
        id: `${ws}-2`,
        kind: 'execution',
        status: 'done',
        createdAt: 2_100,
        updatedAt: 2_600,
      })
      await seed.run({
        workspaceId: ws,
        id: `${ws}-3`,
        kind: 'execution',
        status: 'failed',
        createdAt: 2_200,
        updatedAt: 2_700,
        failureKind: 'agent',
      })
      await seed.run({
        workspaceId: ws,
        id: `${ws}-4`,
        kind: 'bootstrap',
        status: 'done',
        createdAt: 2_300,
        updatedAt: 2_800,
      })
      // Before the window → excluded.
      await seed.run({
        workspaceId: ws,
        id: `${ws}-old`,
        kind: 'execution',
        status: 'done',
        createdAt: 500,
        updatedAt: 600,
      })
      // Different account → excluded.
      await seed.run({
        workspaceId: other.ws,
        id: `${other.ws}-x`,
        kind: 'execution',
        status: 'done',
        createdAt: 2_000,
        updatedAt: 2_100,
      })

      const outcomes = await repo.runOutcomesSince(account, 1_000)
      const key = (o: { kind: string; status: string }) => `${o.kind}/${o.status}`
      const byKey = new Map(outcomes.map((o) => [key(o), o.count]))
      expect(byKey.get('execution/done')).toBe(2)
      expect(byKey.get('execution/failed')).toBe(1)
      expect(byKey.get('bootstrap/done')).toBe(1)
      // No row leaked from before the window or the other account.
      const total = outcomes.reduce((n, o) => n + o.count, 0)
      expect(total).toBe(4)
    })

    it('breaks down failure kinds of failed runs, defaulting missing to unknown', async () => {
      const repo = makeRepo()
      const seed = makeSeed()
      const { account, ws } = ids()
      await seed.workspace(ws, account)
      await seed.run({
        workspaceId: ws,
        id: `${ws}-a`,
        kind: 'execution',
        status: 'failed',
        createdAt: 2_000,
        updatedAt: 2_100,
        failureKind: 'evicted',
      })
      await seed.run({
        workspaceId: ws,
        id: `${ws}-b`,
        kind: 'execution',
        status: 'failed',
        createdAt: 2_010,
        updatedAt: 2_110,
        failureKind: 'evicted',
      })
      await seed.run({
        workspaceId: ws,
        id: `${ws}-c`,
        kind: 'execution',
        status: 'failed',
        createdAt: 2_020,
        updatedAt: 2_120,
        failureKind: 'timeout',
      })
      // Failed with no failure JSON → unknown.
      await seed.run({
        workspaceId: ws,
        id: `${ws}-d`,
        kind: 'execution',
        status: 'failed',
        createdAt: 2_030,
        updatedAt: 2_130,
      })
      // Not failed → excluded.
      await seed.run({
        workspaceId: ws,
        id: `${ws}-ok`,
        kind: 'execution',
        status: 'done',
        createdAt: 2_040,
        updatedAt: 2_140,
      })

      const breakdown = await repo.failureKindBreakdown(account, 1_000)
      const byKind = new Map(breakdown.map((f) => [f.failureKind, f.count]))
      expect(byKind.get('evicted')).toBe(2)
      expect(byKind.get('timeout')).toBe(1)
      expect(byKind.get('unknown')).toBe(1)
      // Sorted by count descending: evicted (2) comes first.
      expect(breakdown[0]?.failureKind).toBe('evicted')
    })

    it('counts live + parked runs (snapshot, not windowed) and ignores terminal ones', async () => {
      const repo = makeRepo()
      const seed = makeSeed()
      const { account, ws } = ids()
      await seed.workspace(ws, account)
      await seed.run({
        workspaceId: ws,
        id: `${ws}-r1`,
        kind: 'execution',
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
      })
      await seed.run({
        workspaceId: ws,
        id: `${ws}-r2`,
        kind: 'execution',
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
      })
      await seed.run({
        workspaceId: ws,
        id: `${ws}-b1`,
        kind: 'execution',
        status: 'blocked',
        createdAt: 1,
        updatedAt: 1,
      })
      await seed.run({
        workspaceId: ws,
        id: `${ws}-p1`,
        kind: 'execution',
        status: 'paused',
        createdAt: 1,
        updatedAt: 1,
      })
      await seed.run({
        workspaceId: ws,
        id: `${ws}-pd`,
        kind: 'bootstrap',
        status: 'pending',
        createdAt: 1,
        updatedAt: 1,
      })
      await seed.run({
        workspaceId: ws,
        id: `${ws}-done`,
        kind: 'execution',
        status: 'done',
        createdAt: 1,
        updatedAt: 1,
      })

      const live = await repo.activeAndParkedCounts(account)
      expect(live).toEqual({ running: 2, blocked: 1, paused: 1, pending: 1 })
    })

    it('computes duration stats over terminal runs in the window only', async () => {
      const repo = makeRepo()
      const seed = makeSeed()
      const { account, ws } = ids()
      await seed.workspace(ws, account)
      // Terminal, in window: durations 1000, 3000 → avg 2000, min 1000, max 3000.
      await seed.run({
        workspaceId: ws,
        id: `${ws}-t1`,
        kind: 'execution',
        status: 'done',
        createdAt: 2_000,
        updatedAt: 3_000,
      })
      await seed.run({
        workspaceId: ws,
        id: `${ws}-t2`,
        kind: 'execution',
        status: 'failed',
        createdAt: 2_000,
        updatedAt: 5_000,
        failureKind: 'agent',
      })
      // Non-terminal → excluded.
      await seed.run({
        workspaceId: ws,
        id: `${ws}-run`,
        kind: 'execution',
        status: 'running',
        createdAt: 2_000,
        updatedAt: 9_000,
      })
      // Terminal but before window → excluded.
      await seed.run({
        workspaceId: ws,
        id: `${ws}-oldt`,
        kind: 'execution',
        status: 'done',
        createdAt: 100,
        updatedAt: 800,
      })

      const stats = await repo.durationStatsSince(account, 1_000)
      expect(stats.count).toBe(2)
      expect(stats.avgMs).toBe(2_000)
      expect(stats.minMs).toBe(1_000)
      expect(stats.maxMs).toBe(3_000)
      // Nearest-rank percentiles over the sorted [1000, 3000] (cume 0.5, 1.0): the first
      // value whose cumulative fraction crosses each threshold.
      expect(stats.p50Ms).toBe(1_000)
      expect(stats.p90Ms).toBe(3_000)
      expect(stats.p99Ms).toBe(3_000)
    })

    it('returns empty duration stats when there are no terminal runs', async () => {
      const repo = makeRepo()
      const seed = makeSeed()
      const { account, ws } = ids()
      await seed.workspace(ws, account)
      await seed.run({
        workspaceId: ws,
        id: `${ws}-run`,
        kind: 'execution',
        status: 'running',
        createdAt: 2_000,
        updatedAt: 9_000,
      })

      const stats = await repo.durationStatsSince(account, 1_000)
      expect(stats).toEqual({
        count: 0,
        avgMs: null,
        minMs: null,
        maxMs: null,
        p50Ms: null,
        p90Ms: null,
        p99Ms: null,
      })
    })

    it('computes discrete (nearest-rank) duration percentiles identically across dialects', async () => {
      const repo = makeRepo()
      const seed = makeSeed()
      const { account, ws } = ids()
      await seed.workspace(ws, account)
      // Ten terminal runs with durations 100..1000. Nearest-rank (cume = k/10): the p-th
      // percentile is the k-th smallest where k/10 >= p — p50 → 500, p90 → 900, p99 → 1000.
      // Seed out of duration order to prove the SQL orders, not the insert sequence.
      const durations = [700, 200, 1_000, 400, 900, 100, 600, 300, 800, 500]
      for (const [i, d] of durations.entries()) {
        await seed.run({
          workspaceId: ws,
          id: `${ws}-d${i}`,
          kind: 'execution',
          status: i % 2 === 0 ? 'done' : 'failed',
          createdAt: 2_000 + i,
          updatedAt: 2_000 + i + d,
        })
      }

      const stats = await repo.durationStatsSince(account, 1_000)
      expect(stats.count).toBe(10)
      expect(stats.minMs).toBe(100)
      expect(stats.maxMs).toBe(1_000)
      expect(stats.avgMs).toBe(550)
      expect(stats.p50Ms).toBe(500)
      expect(stats.p90Ms).toBe(900)
      expect(stats.p99Ms).toBe(1_000)
    })

    it('buckets the outcome trend by the given bucket width', async () => {
      const repo = makeRepo()
      const seed = makeSeed()
      const { account, ws } = ids()
      await seed.workspace(ws, account)
      const bucketMs = 1_000
      // Two runs in bucket starting at 2000, one in bucket starting at 4000.
      await seed.run({
        workspaceId: ws,
        id: `${ws}-a`,
        kind: 'execution',
        status: 'done',
        createdAt: 2_100,
        updatedAt: 2_200,
      })
      await seed.run({
        workspaceId: ws,
        id: `${ws}-b`,
        kind: 'execution',
        status: 'done',
        createdAt: 2_900,
        updatedAt: 3_000,
      })
      await seed.run({
        workspaceId: ws,
        id: `${ws}-c`,
        kind: 'execution',
        status: 'failed',
        createdAt: 4_050,
        updatedAt: 4_200,
        failureKind: 'agent',
      })

      const trend = await repo.runOutcomeTrend(account, 1_000, bucketMs)
      const byBucket = new Map<string, number>()
      for (const p of trend) byBucket.set(`${p.bucketStart}/${p.status}`, p.count)
      expect(byBucket.get('2000/done')).toBe(2)
      expect(byBucket.get('4000/failed')).toBe(1)
    })
  })
}
