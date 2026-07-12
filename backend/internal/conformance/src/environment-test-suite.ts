import type { EnvironmentTestRunRecord, EnvironmentTestRunRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the ephemeral-environment self-test run store
// (`environment_test_runs`, its own table on both facades — D1 on Cloudflare, Postgres via
// Drizzle on Node). This suite drives the SAME insert → get → stage/status patch →
// running-list assertions through whichever real repository a runtime hands it, so a column
// mapped differently or a filter built differently fails a test instead of shipping.

function record(
  overrides: Partial<EnvironmentTestRunRecord> &
    Pick<EnvironmentTestRunRecord, 'id' | 'workspaceId' | 'blockId'>,
): EnvironmentTestRunRecord {
  return {
    status: 'running',
    stage: 'creating_branch',
    initiatedBy: null,
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
        branch: null,
        environmentId: null,
      })

      // Advance through the stages, then settle succeeded — each patch survives the round-trip.
      await repo.update(ws, id, { branch: 'cat-factory/env-test/x', stage: 'provisioning' })
      await repo.update(ws, id, {
        stage: 'tearing_down',
        environmentId: 'env-1',
        envUrl: 'https://x.test',
      })
      await repo.update(ws, id, { stage: 'done', status: 'succeeded', updatedAt: 9 })
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
      await repo.update(ws, id, {
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

    it('scopes get + list by workspace', async () => {
      const repo = makeRepo()
      const a = scope()
      const b = scope()
      await repo.insert(record({ id: a.id, workspaceId: a.ws, blockId: a.block }))
      expect(await repo.get(b.ws, a.id)).toBeNull()
      expect(await repo.listRunningByWorkspace(b.ws)).toEqual([])
    })
  })
}
