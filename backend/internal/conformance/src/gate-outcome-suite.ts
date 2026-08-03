import type { GateOutcomeRecord, GateOutcomeRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the settled-gate projection behind the operator dashboard's gate /
// CI-fixer attempt statistics. Both facades write the same row and aggregate it in their own
// dialect (`SUM(CASE WHEN … )` versus `count(*) filter (where …)`, `ON CONFLICT DO NOTHING`
// versus `onConflictDoNothing`), so a divergent grouping key, a swallowed replay that becomes a
// double count, or an account filter built differently fails a test instead of shipping as a
// dashboard that reports different numbers per runtime.
//
// Every case uses a UNIQUE account id so the account-scoped queries stay isolated on a shared
// database.

/** Raw seed seam: the projection is written through the repository, but workspaces are not. */
export interface GateOutcomeSeed {
  /** Insert a workspace owned by `accountId` (idempotent per id). */
  workspace(id: string, accountId: string): Promise<void>
}

export function defineGateOutcomeSuite(
  name: string,
  makeRepo: () => GateOutcomeRepository,
  makeSeed: () => GateOutcomeSeed,
): void {
  describe(`[${name}] gate outcome repository parity`, () => {
    let seq = 0
    const ids = () => {
      seq += 1
      const tag = `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
      return { account: `acc-${tag}`, ws: `ws-${tag}` }
    }

    const row = (
      over: Partial<GateOutcomeRecord> & Pick<GateOutcomeRecord, 'id' | 'workspaceId'>,
    ): GateOutcomeRecord => ({
      executionId: `exec-${over.id}`,
      blockId: `blk-${over.id}`,
      gateKind: 'ci',
      helperKind: 'ci-fixer',
      outcome: 'passed',
      attempts: 0,
      maxAttempts: 3,
      helperFailures: 0,
      durationMs: 1_000,
      createdAt: 2_000,
      ...over,
    })

    it('groups settled gates by kind, helper and outcome within the window and account', async () => {
      const repo = makeRepo()
      const seed = makeSeed()
      const { account, ws } = ids()
      const other = ids()
      await seed.workspace(ws, account)
      await seed.workspace(other.ws, other.account)

      // Two clean passes, one pass after two fixer attempts (one of which crashed).
      await repo.record(row({ id: `${ws}-1`, workspaceId: ws }))
      await repo.record(row({ id: `${ws}-2`, workspaceId: ws }))
      await repo.record(row({ id: `${ws}-3`, workspaceId: ws, attempts: 2, helperFailures: 1 }))
      // One gate that spent its budget and handed off to a human.
      await repo.record(row({ id: `${ws}-4`, workspaceId: ws, outcome: 'exhausted', attempts: 3 }))
      // A different gate kind entirely.
      await repo.record(
        row({
          id: `${ws}-5`,
          workspaceId: ws,
          gateKind: 'conflicts',
          helperKind: 'conflict-resolver',
        }),
      )
      // Before the window → excluded.
      await repo.record(row({ id: `${ws}-old`, workspaceId: ws, createdAt: 500 }))
      // Different account → excluded.
      await repo.record(row({ id: `${other.ws}-x`, workspaceId: other.ws }))

      const stats = await repo.statsSince(account, 1_000)
      const key = (s: { gateKind: string; outcome: string }) => `${s.gateKind}/${s.outcome}`
      const byKey = new Map(stats.map((s) => [key(s), s]))

      const ciPassed = byKey.get('ci/passed')!
      expect(ciPassed.gates).toBe(3)
      expect(ciPassed.helperKind).toBe('ci-fixer')
      expect(ciPassed.attempts).toBe(2)
      expect(ciPassed.helperFailures).toBe(1)
      // The two gates the precheck satisfied outright: the number the whole
      // precheck-before-escalate design exists to move, and invisible in `gates` alone.
      expect(ciPassed.cleanGates).toBe(2)

      const ciExhausted = byKey.get('ci/exhausted')!
      expect(ciExhausted.gates).toBe(1)
      expect(ciExhausted.attempts).toBe(3)
      expect(ciExhausted.cleanGates).toBe(0)

      expect(byKey.get('conflicts/passed')?.gates).toBe(1)
      // Nothing leaked from before the window or from the neighbouring account.
      expect(stats.reduce((n, s) => n + s.gates, 0)).toBe(5)
    })

    it('is idempotent on the derived id, so a driver replay cannot double-count a gate', async () => {
      // The engine derives the id from `<runId>:<stepIndex>:<outcome>` precisely so a replayed
      // settle collapses onto one row. A second insert must also NOT overwrite the first with
      // whatever the replay recomputed.
      const repo = makeRepo()
      const seed = makeSeed()
      const { account, ws } = ids()
      await seed.workspace(ws, account)
      await repo.record(row({ id: `${ws}-r`, workspaceId: ws, attempts: 2 }))
      await repo.record(row({ id: `${ws}-r`, workspaceId: ws, attempts: 99 }))

      const stats = await repo.statsSince(account, 1_000)
      expect(stats).toHaveLength(1)
      expect(stats[0]?.gates).toBe(1)
      expect(stats[0]?.attempts).toBe(2)
    })

    it('records a gate with no helper without losing it from the statistics', async () => {
      const repo = makeRepo()
      const seed = makeSeed()
      const { account, ws } = ids()
      await seed.workspace(ws, account)
      await repo.record(row({ id: `${ws}-n`, workspaceId: ws, helperKind: null }))
      const stats = await repo.statsSince(account, 1_000)
      expect(stats).toHaveLength(1)
      expect(stats[0]?.helperKind).toBeNull()
      expect(stats[0]?.gates).toBe(1)
    })

    it('prunes settled gates older than the cutoff', async () => {
      const repo = makeRepo()
      const seed = makeSeed()
      const { account, ws } = ids()
      await seed.workspace(ws, account)
      await repo.record(row({ id: `${ws}-p-old`, workspaceId: ws, createdAt: 1_000 }))
      await repo.record(row({ id: `${ws}-p-new`, workspaceId: ws, createdAt: 9_000 }))
      await repo.deleteOlderThan(5_000)
      const stats = await repo.statsSince(account, 0)
      expect(stats.reduce((n, s) => n + s.gates, 0)).toBe(1)
    })
  })
}
