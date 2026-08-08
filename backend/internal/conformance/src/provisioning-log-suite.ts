import type { ProvisioningLogRecord, ProvisioningLogRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the unified provisioning event log. The recorder that
// writes these is runtime-neutral, but each facade persists them in its own SEPARATE
// store (a dedicated D1 binding on Cloudflare, a dedicated Postgres schema on Node).
// This suite drives the SAME append → list (filtered, newest-first) → prune assertions
// through whichever real repository a runtime hands it, so a column mapped differently
// or a filter built differently fails a test instead of shipping. Both runtimes invoke
// it over their real separate database.

function record(
  overrides: Partial<ProvisioningLogRecord> & Pick<ProvisioningLogRecord, 'id'>,
): ProvisioningLogRecord {
  return {
    workspaceId: 'ws',
    subsystem: 'environment',
    operation: 'provision',
    targetId: null,
    providerId: null,
    blockId: null,
    executionId: null,
    outcome: 'success',
    error: null,
    detail: null,
    createdAt: 1,
    ...overrides,
  }
}

/**
 * Assert a runtime's {@link ProvisioningLogRepository} behaves identically to the
 * others. `makeRepo` returns a repo over the runtime's real separate store; ids/
 * workspaces are unique per run so the shared database stays isolated between cases.
 */
export function defineProvisioningLogSuite(
  name: string,
  makeRepo: () => ProvisioningLogRepository,
): void {
  describe(`[${name}] provisioning log repository parity`, () => {
    let seq = 0
    const ids = () => {
      seq += 1
      const tag = `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
      return { ws: `ws-${tag}`, e1: `e1-${tag}`, e2: `e2-${tag}` }
    }

    it('appends events and lists them newest-first per workspace', async () => {
      const repo = makeRepo()
      const { ws } = ids()
      await repo.append(record({ id: `${ws}-a`, workspaceId: ws, createdAt: 10 }))
      await repo.append(record({ id: `${ws}-b`, workspaceId: ws, createdAt: 30 }))
      await repo.append(record({ id: `${ws}-c`, workspaceId: ws, createdAt: 20 }))

      const rows = await repo.list(ws)
      expect(rows.map((r) => r.id)).toEqual([`${ws}-b`, `${ws}-c`, `${ws}-a`])
    })

    it('round-trips the full record including the verbatim failure error + detail', async () => {
      const repo = makeRepo()
      const { ws, e1 } = ids()
      await repo.append(
        record({
          id: `${ws}-fail`,
          workspaceId: ws,
          subsystem: 'container',
          operation: 'dispatch',
          targetId: 'job-1',
          executionId: e1,
          blockId: 'blk-1',
          providerId: 'pool-x',
          outcome: 'failure',
          error: 'Container dispatch failed (HTTP 503): no capacity',
          detail: '{"kind":"agent"}',
          createdAt: 5,
        }),
      )
      const row = (await repo.list(ws))[0]!
      expect(row).toMatchObject({
        subsystem: 'container',
        operation: 'dispatch',
        targetId: 'job-1',
        executionId: e1,
        blockId: 'blk-1',
        providerId: 'pool-x',
        outcome: 'failure',
        error: 'Container dispatch failed (HTTP 503): no capacity',
        detail: '{"kind":"agent"}',
      })
    })

    it('filters by subsystem, execution and target', async () => {
      const repo = makeRepo()
      const { ws, e1, e2 } = ids()
      await repo.append(
        record({
          id: `${ws}-env`,
          workspaceId: ws,
          subsystem: 'environment',
          executionId: e1,
          targetId: `${ws}-job`,
        }),
      )
      await repo.append(
        record({
          id: `${ws}-pool`,
          workspaceId: ws,
          subsystem: 'runner-pool',
          operation: 'dispatch',
          executionId: e1,
          targetId: `${ws}-job`,
        }),
      )
      await repo.append(
        record({
          id: `${ws}-other`,
          workspaceId: ws,
          subsystem: 'container',
          operation: 'dispatch',
          executionId: e2,
          targetId: `${ws}-elsewhere`,
        }),
      )

      expect((await repo.list(ws, { subsystem: 'runner-pool' })).map((r) => r.id)).toEqual([
        `${ws}-pool`,
      ])
      expect((await repo.list(ws, { executionId: e1 })).map((r) => r.id).sort()).toEqual(
        [`${ws}-env`, `${ws}-pool`].sort(),
      )
      // `targetId` is the axis an operator follows one container job / one environment by, and it
      // cuts ACROSS subsystems (a job is dispatched by one and reclaimed by another), so it must
      // narrow on its own rather than only alongside a subsystem.
      expect((await repo.list(ws, { targetId: `${ws}-job` })).map((r) => r.id).sort()).toEqual(
        [`${ws}-env`, `${ws}-pool`].sort(),
      )
      expect(await repo.list(ws, { targetId: `${ws}-absent` })).toEqual([])
    })

    it('honours the limit (newest first)', async () => {
      const repo = makeRepo()
      const { ws } = ids()
      await repo.append(record({ id: `${ws}-1`, workspaceId: ws, createdAt: 1 }))
      await repo.append(record({ id: `${ws}-2`, workspaceId: ws, createdAt: 2 }))
      await repo.append(record({ id: `${ws}-3`, workspaceId: ws, createdAt: 3 }))
      expect((await repo.list(ws, { limit: 2 })).map((r) => r.id)).toEqual([`${ws}-3`, `${ws}-2`])
    })

    // --- the remote debugging surface's bounded page (`/api/v1/debug/runs/:runId/logs`) ---
    it('pages with a composite keyset cursor, keeping rows that share a millisecond', async () => {
      const repo = makeRepo()
      const { ws, e1 } = ids()
      await repo.append(record({ id: `${ws}-a`, workspaceId: ws, executionId: e1, createdAt: 10 }))
      // Provisioning attempts are appended in bursts, so same-millisecond rows are the norm
      // here — the exact case the old `before: number` keyset dropped between pages.
      await repo.append(record({ id: `${ws}-b`, workspaceId: ws, executionId: e1, createdAt: 20 }))
      await repo.append(record({ id: `${ws}-c`, workspaceId: ws, executionId: e1, createdAt: 20 }))

      const first = await repo.list(ws, { executionId: e1, limit: 2 })
      expect(first.map((r) => r.id)).toEqual([`${ws}-c`, `${ws}-b`])
      const last = first[first.length - 1]!
      const second = await repo.list(ws, {
        executionId: e1,
        limit: 2,
        cursor: { createdAt: last.createdAt, id: last.id },
      })
      expect(second.map((r) => r.id)).toEqual([`${ws}-a`])
    })

    it("counts a run's attempts, and its failures separately", async () => {
      const repo = makeRepo()
      const { ws, e1, e2 } = ids()
      await repo.append(record({ id: `${ws}-ok`, workspaceId: ws, executionId: e1 }))
      await repo.append(
        record({ id: `${ws}-f1`, workspaceId: ws, executionId: e1, outcome: 'failure' }),
      )
      await repo.append(
        record({ id: `${ws}-f2`, workspaceId: ws, executionId: e1, outcome: 'failure' }),
      )
      await repo.append(record({ id: `${ws}-x`, workspaceId: ws, executionId: e2 }))

      // Total + failures come back from ONE aggregate pass. The failure count is what a run
      // overview reports as its highest-severity signal: for a run whose container never came
      // up there is no model telemetry at all to explain it.
      expect(await repo.countByExecution(ws, e1)).toEqual({ total: 3, failures: 2 })
      expect(await repo.countByExecution(ws, e2)).toEqual({ total: 1, failures: 0 })
    })

    it('prunes rows older than a cutoff', async () => {
      const repo = makeRepo()
      const { ws } = ids()
      await repo.append(record({ id: `${ws}-old`, workspaceId: ws, createdAt: 1_000 }))
      await repo.append(record({ id: `${ws}-new`, workspaceId: ws, createdAt: 9_000_000 }))
      const removed = await repo.deleteOlderThan(2_000)
      expect(removed).toBeGreaterThanOrEqual(1)
      expect((await repo.list(ws)).map((r) => r.id)).toEqual([`${ws}-new`])
    })
  })
}
