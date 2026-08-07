import { describe, expect, it, vi } from 'vitest'
import { createRecordingLogger } from '@cat-factory/kernel'
import type {
  BinaryArtifactStore,
  GroupCacheHandle,
  ResolveBinaryArtifactStore,
  Workspace,
  WorkspaceAccessCacheValue,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { WorkspaceService } from './WorkspaceService.js'

// A board delete must reclaim the workspace's binary artifacts (screenshots + reference images)
// — BOTH the metadata rows AND the heavy blob bytes — BEFORE the row cascade, because the
// retention sweeps never see a deleted workspace again and `binary_artifacts` is deliberately
// excluded from the SQL cascade (dropping the row without the bytes strands the blob forever).

const WS: Workspace = {
  id: 'ws-1',
  name: 'Board',
  description: null,
  createdAt: 1,
  accountId: null,
}

function fakeWorkspaceRepository(deleteSpy: WorkspaceRepository['delete']): WorkspaceRepository {
  // Only the two members `delete()` reaches are stubbed (get for the existence guard + delete
  // for the cascade); everything else is unused here.
  return {
    get: (id: string) => Promise.resolve(id === WS.id ? WS : null),
    delete: deleteSpy,
  } as unknown as WorkspaceRepository
}

const baseDeps = (resolveBinaryArtifactStore?: ResolveBinaryArtifactStore) => {
  const deleteSpy = vi.fn(() => Promise.resolve())
  const logger = createRecordingLogger()
  const service = new WorkspaceService({
    workspaceRepository: fakeWorkspaceRepository(deleteSpy),
    blockRepository: {} as never,
    pipelineRepository: {} as never,
    executionRepository: {} as never,
    idGenerator: { next: () => 'x' },
    clock: { now: () => 1 },
    resolveBinaryArtifactStore,
    logger,
  })
  return { service, deleteSpy, logger }
}

describe('WorkspaceService.delete — binary-artifact purge', () => {
  it('purges the workspace’s artifacts through the store before the row cascade', async () => {
    const order: string[] = []
    const deleteByWorkspace = vi.fn((id: string) => {
      order.push(`purge:${id}`)
      return Promise.resolve(2)
    })
    const store = { deleteByWorkspace } as unknown as BinaryArtifactStore
    const resolve: ResolveBinaryArtifactStore = () => Promise.resolve(store)

    const { service, deleteSpy } = baseDeps(resolve)
    deleteSpy.mockImplementation(() => {
      order.push('cascade')
      return Promise.resolve()
    })

    await service.delete(WS.id)

    expect(deleteByWorkspace).toHaveBeenCalledWith(WS.id)
    // Bytes+rows reclaimed BEFORE the SQL cascade drops the remaining tables.
    expect(order).toEqual([`purge:${WS.id}`, 'cascade'])
  })

  it('still deletes the board when the artifact store is unwired (no content storage)', async () => {
    const { service, deleteSpy } = baseDeps(undefined)
    await service.delete(WS.id)
    expect(deleteSpy).toHaveBeenCalledWith(WS.id, [])
  })

  it('still deletes the board when the resolver returns null (storage off)', async () => {
    const resolve: ResolveBinaryArtifactStore = () => Promise.resolve(null)
    const { service, deleteSpy } = baseDeps(resolve)
    await service.delete(WS.id)
    expect(deleteSpy).toHaveBeenCalledWith(WS.id, [])
  })

  it('drops the deleted board’s workspace-access cache group (after the cascade)', async () => {
    const order: string[] = []
    const invalidateGroup = vi.fn((group: string) => {
      order.push(`invalidate:${group}`)
      return Promise.resolve()
    })
    const workspaceAccessCache = {
      invalidateGroup,
    } as unknown as GroupCacheHandle<WorkspaceAccessCacheValue>
    const deleteSpy = vi.fn(() => {
      order.push('cascade')
      return Promise.resolve()
    })
    const service = new WorkspaceService({
      workspaceRepository: fakeWorkspaceRepository(deleteSpy),
      blockRepository: {} as never,
      pipelineRepository: {} as never,
      executionRepository: {} as never,
      idGenerator: { next: () => 'x' },
      clock: { now: () => 1 },
      workspaceAccessCache,
    })

    await service.delete(WS.id)

    expect(invalidateGroup).toHaveBeenCalledWith(WS.id)
    // Invalidate only AFTER the row cascade commits (invalidation is the coherence story).
    expect(order).toEqual(['cascade', `invalidate:${WS.id}`])
  })

  it('does not let a blob-backend outage wedge the board delete', async () => {
    // (the spend fold is unwired here, so this logger holds only the purge line)
    const store = {
      deleteByWorkspace: () => Promise.reject(new Error('R2 down')),
    } as unknown as BinaryArtifactStore
    const resolve: ResolveBinaryArtifactStore = () => Promise.resolve(store)
    const { service, deleteSpy, logger } = baseDeps(resolve)
    // The purge throws, but the board still deletes (rows survive for an out-of-band reclaim).
    await expect(service.delete(WS.id)).resolves.toBeUndefined()
    expect(deleteSpy).toHaveBeenCalledWith(WS.id, [])
    // The swallowed failure is surfaced (not silent) so the residual leak is visible.
    expect(logger.lines.filter((l) => l.level === 'info')).toHaveLength(1)
    expect(logger.lines[0]?.fields).toMatchObject({ workspaceId: WS.id })
  })
})

// The board's LAST fold into the durable cost rollup. `spend_days` deliberately survives a board
// delete, but the sweep that fills it only reaches boards that still exist, so everything the
// board spent since the last completed rollup day was never folded and its `token_usage` rows go
// with the cascade. Nothing else in the system gets another chance at them.

const DAY = 24 * 60 * 60_000
const NOW = 1_000 * DAY
const LEDGER_MS = 395 * DAY

function spendFoldDeps(
  rollup: {
    watermark?: number | null
    fold?: (workspaceId: string, from: number, to: number) => Promise<number>
  },
  order?: string[],
) {
  const folds: Array<{ workspaceId: string; from: number; to: number }> = []
  const deleteSpy = vi.fn(() => {
    order?.push('cascade')
    return Promise.resolve()
  })
  const logger = createRecordingLogger()
  const service = new WorkspaceService({
    workspaceRepository: fakeWorkspaceRepository(deleteSpy),
    blockRepository: {} as never,
    pipelineRepository: {} as never,
    executionRepository: {} as never,
    idGenerator: { next: () => 'x' },
    clock: { now: () => NOW },
    spendRollupRepository: {
      spendRollupWatermark: () => Promise.resolve(rollup.watermark ?? null),
      rollupWorkspaceSpendDays: (workspaceId, from, to) => {
        order?.push('fold')
        folds.push({ workspaceId, from, to })
        return rollup.fold?.(workspaceId, from, to) ?? Promise.resolve(1)
      },
    },
    tokenUsageRetentionMs: LEDGER_MS,
    logger,
  })
  return { service, deleteSpy, logger, folds }
}

describe('WorkspaceService.delete — final durable spend fold', () => {
  it('folds the board’s un-rolled days BEFORE the cascade takes the ledger rows', async () => {
    // Ordering is the whole property. Afterwards `token_usage` is gone and the fold reads
    // nothing, so the same call would freeze an empty board rather than its last few days.
    const order: string[] = []
    const { service, folds } = spendFoldDeps({ watermark: NOW - 10 * DAY }, order)
    await service.delete(WS.id)
    expect(order).toEqual(['fold', 'cascade'])
    expect(folds).toEqual([{ workspaceId: WS.id, from: NOW - 10 * DAY, to: NOW }])
  })

  it('walks a wide catch-up in chunks rather than leaving a remainder behind', async () => {
    // A sweep pass caps its window and picks the rest up next time. This board has no next
    // time, so every day back to the resume point has to be covered before the delete lands.
    const { service, folds } = spendFoldDeps({ watermark: NOW - 70 * DAY })
    await service.delete(WS.id)
    expect(folds.length).toBeGreaterThan(1)
    expect(folds[0]?.from).toBe(NOW - 70 * DAY)
    expect(folds.at(-1)?.to).toBe(NOW)
    for (const [i, fold] of folds.slice(1).entries()) expect(fold.from).toBe(folds[i]?.to)
  })

  it('names the days the ledger no longer holds, which nothing downstream can restate', async () => {
    const { service, logger } = spendFoldDeps({ watermark: NOW - 3 * LEDGER_MS })
    await service.delete(WS.id)
    const warn = logger.lines.find((l) => l.level === 'warn')
    expect(warn?.fields).toMatchObject({
      workspaceId: WS.id,
      table: 'spend_days',
      skippedFrom: NOW - 3 * LEDGER_MS,
      skippedTo: NOW - LEDGER_MS,
    })
  })

  it('does not let a sick rollup wedge the delete, and says what it dropped', async () => {
    // The trade this posture makes: refusing the delete would keep the spend foldable for a
    // retry, but it would also render a reporting outage as a board that cannot be deleted. So
    // the delete proceeds and the loss is NAMED, because it is unrecoverable a moment later.
    const { service, deleteSpy, logger } = spendFoldDeps({
      watermark: NOW - DAY,
      fold: () => Promise.reject(new Error('statement timeout')),
    })
    await expect(service.delete(WS.id)).resolves.toBeUndefined()
    expect(deleteSpy).toHaveBeenCalledWith(WS.id, [])
    expect(logger.lines.some((l) => l.level === 'warn' && /spend fold/.test(l.msg))).toBe(true)
  })

  it('deletes the board unchanged when the rollup is not wired', async () => {
    const { service, deleteSpy } = baseDeps(undefined)
    await service.delete(WS.id)
    expect(deleteSpy).toHaveBeenCalledWith(WS.id, [])
  })
})
