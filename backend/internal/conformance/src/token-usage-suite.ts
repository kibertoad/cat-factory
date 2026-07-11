import type { TokenUsageRecord, TokenUsageRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the token-usage ledger (the spend safeguard's append-only
// store). The SpendService that reads it is runtime-neutral, but each facade persists the
// rows in its own store (D1 on Cloudflare, Postgres via Drizzle on Node). This suite drives
// the SAME record → per-group breakdown → metered-only totals → retention prune assertions
// through whichever real repository a runtime hands it, so a column mapped differently, a
// GROUP BY built differently, or a prune predicate off by one fails a test instead of
// shipping. The prune is the retention sweep's write for this otherwise-unbounded ledger —
// it must delete rows strictly older than the cutoff and never touch newer history.

function record(
  overrides: Partial<TokenUsageRecord> & Pick<TokenUsageRecord, 'id' | 'workspaceId'>,
): TokenUsageRecord {
  return {
    accountId: null,
    userId: null,
    executionId: null,
    agentKind: 'coder',
    provider: 'openai',
    model: 'gpt',
    inputTokens: 0,
    outputTokens: 0,
    costEstimate: 0,
    billing: 'metered',
    vendor: null,
    createdAt: 1,
    ...overrides,
  }
}

/**
 * Assert a runtime's {@link TokenUsageRepository} behaves identically to the others.
 * `makeRepo` returns a repo over the runtime's real store; workspace ids are unique per
 * case so the shared (table-wide) database stays isolated between cases.
 */
export function defineTokenUsageSuite(name: string, makeRepo: () => TokenUsageRepository): void {
  describe(`[${name}] token-usage repository parity`, () => {
    let seq = 0
    const workspaceId = () => {
      seq += 1
      return `${name}-ws-${seq}-${Math.floor(Math.random() * 1e9)}`
    }

    it('groups usage per (billing, vendor, provider, model) and excludes subscription from spend', async () => {
      const repo = makeRepo()
      const ws = workspaceId()
      // Two metered calls in the same group fold into one row (calls = 2, summed counters).
      await repo.record(
        record({
          id: `${ws}-m1`,
          workspaceId: ws,
          inputTokens: 100,
          outputTokens: 50,
          costEstimate: 1.5,
        }),
      )
      await repo.record(
        record({
          id: `${ws}-m2`,
          workspaceId: ws,
          inputTokens: 40,
          outputTokens: 10,
          costEstimate: 0.5,
        }),
      )
      // A flat-rate subscription call: counted in the usage report, excluded from spend.
      await repo.record(
        record({
          id: `${ws}-s1`,
          workspaceId: ws,
          billing: 'subscription',
          vendor: 'claude',
          provider: 'anthropic',
          model: 'claude',
          inputTokens: 1_000,
          outputTokens: 1_000,
          costEstimate: 5,
        }),
      )

      const breakdown = await repo.usageBreakdownForWorkspace(ws, 0)
      const metered = breakdown.find((r) => r.billing === 'metered')!
      expect(metered).toMatchObject({
        provider: 'openai',
        model: 'gpt',
        vendor: null,
        inputTokens: 140,
        outputTokens: 60,
        calls: 2,
      })
      const subscription = breakdown.find((r) => r.billing === 'subscription')!
      expect(subscription).toMatchObject({ vendor: 'claude', provider: 'anthropic', calls: 1 })

      // Spend rollup is metered-only: the subscription row's 1000/1000 tokens must not leak.
      const totals = await repo.totalsSinceForWorkspace(ws, 0)
      expect(totals).toMatchObject({ inputTokens: 140, outputTokens: 60, costEstimate: 2 })
    })

    it('scopes the breakdown to one workspace', async () => {
      const repo = makeRepo()
      const ws = workspaceId()
      const other = workspaceId()
      await repo.record(record({ id: `${ws}-a`, workspaceId: ws, inputTokens: 5, outputTokens: 5 }))
      await repo.record(
        record({ id: `${other}-a`, workspaceId: other, inputTokens: 7, outputTokens: 7 }),
      )
      expect((await repo.usageBreakdownForWorkspace(ws, 0)).length).toBe(1)
      expect((await repo.totalsSinceForWorkspace(ws, 0)).inputTokens).toBe(5)
    })

    it('prunes rows older than the cutoff (exclusive), keeping newer history', async () => {
      const repo = makeRepo()
      const ws = workspaceId()
      await repo.record(
        record({
          id: `${ws}-old`,
          workspaceId: ws,
          inputTokens: 3,
          outputTokens: 3,
          createdAt: 1_000,
        }),
      )
      await repo.record(
        record({
          id: `${ws}-new`,
          workspaceId: ws,
          inputTokens: 9,
          outputTokens: 9,
          createdAt: 5_000,
        }),
      )
      // Table-wide prune, so its count can include other cases' rows in the shared DB —
      // assert the scoped, deterministic outcome instead.
      const removed = await repo.deleteOlderThan(2_000)
      expect(removed).toBeGreaterThanOrEqual(1)
      const breakdown = await repo.usageBreakdownForWorkspace(ws, 0)
      expect(breakdown).toHaveLength(1)
      expect(breakdown[0]).toMatchObject({ inputTokens: 9, outputTokens: 9, calls: 1 })
    })
  })
}
