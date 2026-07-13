import type {
  EnvironmentTestRunRecord,
  EnvironmentTestRunRepository,
  ServiceProvisioning,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the ephemeral-environment self-test run store
// (`environment_test_runs`, its own table on both facades — D1 on Cloudflare, Postgres via
// Drizzle on Node). This suite drives the SAME insert → get → guarded stage/status patch →
// running-list → stale-list assertions through whichever real repository a runtime hands
// it, so a column mapped differently or a filter built differently fails a test instead of
// shipping.

const PROVISIONING: ServiceProvisioning = { type: 'kubernetes' }

function record(
  overrides: Partial<EnvironmentTestRunRecord> &
    Pick<EnvironmentTestRunRecord, 'id' | 'workspaceId' | 'blockId'>,
): EnvironmentTestRunRecord {
  return {
    status: 'running',
    stage: 'creating_branch',
    initiatedBy: null,
    provisioning: PROVISIONING,
    branch: null,
    environmentId: null,
    envUrl: null,
    error: null,
    failedStage: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

/**
 * Assert a runtime's {@link EnvironmentTestRunRepository} behaviour is identical across
 * facades. `makeRepo` returns a repo over the runtime's real store; ids are unique per case so
 * the shared database stays isolated between cases.
 */
export function defineEnvironmentTestSuite(
  name: string,
  makeRepo: () => EnvironmentTestRunRepository,
): void {
  describe(`[${name}] environment-test run repository parity`, () => {
    let seq = 0
    const scope = () => {
      seq += 1
      const tag = `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
      return { ws: `ws-${tag}`, block: `blk-${tag}`, id: `envtest-${tag}` }
    }

    it('inserts, reads back all fields, and patches stage/status in place', async () => {
      const repo = makeRepo()
      const { ws, block, id } = scope()
      await repo.insert(
        record({ id, workspaceId: ws, blockId: block, initiatedBy: 'usr-1', createdAt: 5 }),
      )

      const got = await repo.get(ws, id)
      expect(got).toMatchObject({
        id,
        workspaceId: ws,
        blockId: block,
        status: 'running',
        stage: 'creating_branch',
        initiatedBy: 'usr-1',
        provisioning: PROVISIONING,
        branch: null,
        environmentId: null,
      })

      // Advance through the stages, then settle succeeded — each patch survives the
      // round-trip and reports that it was applied.
      expect(
        await repo.updateIfRunning(ws, id, {
          branch: 'cat-factory/env-test/x',
          stage: 'provisioning',
        }),
      ).toBe(true)
      expect(
        await repo.updateIfRunning(ws, id, {
          stage: 'tearing_down',
          environmentId: 'env-1',
          envUrl: 'https://x.test',
        }),
      ).toBe(true)
      expect(
        await repo.updateIfRunning(ws, id, { stage: 'done', status: 'succeeded', updatedAt: 9 }),
      ).toBe(true)
      expect(await repo.get(ws, id)).toMatchObject({
        status: 'succeeded',
        stage: 'done',
        branch: 'cat-factory/env-test/x',
        environmentId: 'env-1',
        envUrl: 'https://x.test',
        updatedAt: 9,
      })
    })

    it('records a failure with its failing stage', async () => {
      const repo = makeRepo()
      const { ws, block, id } = scope()
      await repo.insert(record({ id, workspaceId: ws, blockId: block, stage: 'provisioning' }))
      await repo.updateIfRunning(ws, id, {
        status: 'failed',
        error: 'boom',
        failedStage: 'provisioning',
      })
      expect(await repo.get(ws, id)).toMatchObject({
        status: 'failed',
        error: 'boom',
        failedStage: 'provisioning',
      })
    })

    it('refuses to patch a terminal run (the stop ⇄ driver race guard)', async () => {
      const repo = makeRepo()
      const { ws, block, id } = scope()
      await repo.insert(record({ id, workspaceId: ws, blockId: block, stage: 'provisioning' }))
      await repo.updateIfRunning(ws, id, { status: 'failed', error: 'stopped', updatedAt: 2 })

      // A late driver write must be rejected AND leave the terminal state untouched.
      expect(
        await repo.updateIfRunning(ws, id, { status: 'succeeded', stage: 'done', updatedAt: 3 }),
      ).toBe(false)
      expect(await repo.get(ws, id)).toMatchObject({
        status: 'failed',
        error: 'stopped',
        updatedAt: 2,
      })
    })

    it('lists only RUNNING runs for a workspace, newest-first', async () => {
      const repo = makeRepo()
      const { ws, block } = scope()
      await repo.insert(record({ id: `${ws}-a`, workspaceId: ws, blockId: block, createdAt: 1 }))
      await repo.insert(record({ id: `${ws}-b`, workspaceId: ws, blockId: block, createdAt: 3 }))
      const done = `${ws}-c`
      await repo.insert(
        record({ id: done, workspaceId: ws, blockId: block, createdAt: 5, status: 'succeeded' }),
      )

      const running = await repo.listRunningByWorkspace(ws)
      expect(running.map((r) => r.id)).toEqual([`${ws}-b`, `${ws}-a`])
    })

    it('scopes get + list + update by workspace', async () => {
      const repo = makeRepo()
      const a = scope()
      const b = scope()
      await repo.insert(record({ id: a.id, workspaceId: a.ws, blockId: a.block }))
      expect(await repo.get(b.ws, a.id)).toBeNull()
      expect(await repo.listRunningByWorkspace(b.ws)).toEqual([])
      // A cross-workspace update must not write (the WHERE keeps the workspace predicate).
      expect(await repo.updateIfRunning(b.ws, a.id, { status: 'failed', error: 'x' })).toBe(false)
      expect(await repo.get(a.ws, a.id)).toMatchObject({ status: 'running', error: null })
    })

    it('lists stale RUNNING runs across workspaces, oldest first', async () => {
      const repo = makeRepo()
      const a = scope()
      const b = scope()
      const c = scope()
      // Unique far-future lease stamps so this case never collides with other cases
      // sharing the store (listStale is deliberately cross-workspace).
      const base = 9_000_000_000_000 + seq * 1_000
      await repo.insert(
        record({ id: a.id, workspaceId: a.ws, blockId: a.block, updatedAt: base + 1 }),
      )
      await repo.insert(
        record({ id: b.id, workspaceId: b.ws, blockId: b.block, updatedAt: base + 2 }),
      )
      // Terminal + fresh rows must both be excluded.
      await repo.insert(
        record({
          id: c.id,
          workspaceId: c.ws,
          blockId: c.block,
          status: 'failed',
          updatedAt: base + 1,
        }),
      )
      const stale = (await repo.listStale(base + 3)).filter((r) =>
        [a.id, b.id, c.id].includes(r.id),
      )
      expect(stale.map((r) => r.id)).toEqual([a.id, b.id])
      const fresh = (await repo.listStale(base + 1)).filter((r) =>
        [a.id, b.id, c.id].includes(r.id),
      )
      expect(fresh).toEqual([])
    })
  })
}
