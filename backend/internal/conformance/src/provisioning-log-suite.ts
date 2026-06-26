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

    it('filters by subsystem and execution', async () => {
      const repo = makeRepo()
      const { ws, e1, e2 } = ids()
      await repo.append(
        record({ id: `${ws}-env`, workspaceId: ws, subsystem: 'environment', executionId: e1 }),
      )
      await repo.append(
        record({
          id: `${ws}-pool`,
          workspaceId: ws,
          subsystem: 'runner-pool',
          operation: 'dispatch',
          executionId: e1,
        }),
      )
      await repo.append(
        record({
          id: `${ws}-other`,
          workspaceId: ws,
          subsystem: 'container',
          operation: 'dispatch',
          executionId: e2,
        }),
      )

      expect((await repo.list(ws, { subsystem: 'runner-pool' })).map((r) => r.id)).toEqual([
        `${ws}-pool`,
      ])
      expect((await repo.list(ws, { executionId: e1 })).map((r) => r.id).sort()).toEqual(
        [`${ws}-env`, `${ws}-pool`].sort(),
      )
    })

    it('honours the limit (newest first)', async () => {
      const repo = makeRepo()
      const { ws } = ids()
      await repo.append(record({ id: `${ws}-1`, workspaceId: ws, createdAt: 1 }))
      await repo.append(record({ id: `${ws}-2`, workspaceId: ws, createdAt: 2 }))
      await repo.append(record({ id: `${ws}-3`, workspaceId: ws, createdAt: 3 }))
      expect((await repo.list(ws, { limit: 2 })).map((r) => r.id)).toEqual([`${ws}-3`, `${ws}-2`])
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
