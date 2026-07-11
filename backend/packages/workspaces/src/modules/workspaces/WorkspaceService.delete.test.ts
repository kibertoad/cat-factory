import { describe, expect, it, vi } from 'vitest'
import type {
  BinaryArtifactStore,
  ResolveBinaryArtifactStore,
  Workspace,
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
  const service = new WorkspaceService({
    workspaceRepository: fakeWorkspaceRepository(deleteSpy),
    blockRepository: {} as never,
    pipelineRepository: {} as never,
    executionRepository: {} as never,
    idGenerator: { next: () => 'x' },
    clock: { now: () => 1 },
    resolveBinaryArtifactStore,
  })
  return { service, deleteSpy }
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

  it('does not let a blob-backend outage wedge the board delete', async () => {
    const store = {
      deleteByWorkspace: () => Promise.reject(new Error('R2 down')),
    } as unknown as BinaryArtifactStore
    const resolve: ResolveBinaryArtifactStore = () => Promise.resolve(store)
    const { service, deleteSpy } = baseDeps(resolve)
    // The purge throws, but the board still deletes (rows survive for a later retry).
    await expect(service.delete(WS.id)).resolves.toBeUndefined()
    expect(deleteSpy).toHaveBeenCalledWith(WS.id, [])
  })
})
