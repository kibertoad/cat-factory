import { describe, expect, it } from 'vitest'
import type { Block, Service } from '@cat-factory/kernel'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'

// Deleting a service reclaims its account-owned `Service` (the repo↔frame link) so the repo is
// re-addable; a service that still has unfinished work is archived (hidden, restorable) instead
// of deleted.
describe('BoardService — service delete cleanup, delete guard, archive/restore', () => {
  const WS = 'ws_1'
  const ACC = 'acc_1'

  function frame(id: string, over: Partial<Block> = {}): Block {
    return {
      id,
      title: id,
      type: 'service',
      description: '',
      position: { x: 0, y: 0 },
      status: 'ready',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'frame',
      parentId: null,
      ...over,
    }
  }

  /** Build a BoardService over in-memory blocks + services, tracking archive patches. */
  function build(initialBlocks: Block[], services: Service[] = []) {
    const blocksMap = new Map(initialBlocks.map((b) => [b.id, b]))
    const servicesMap = new Map(services.map((s) => [s.id, s]))
    const mounts = new Map<string, { workspaceId: string; serviceId: string }>()
    for (const s of services) mounts.set(`${WS}:${s.id}`, { workspaceId: WS, serviceId: s.id })

    const deps = {
      workspaceRepository: { get: async (id: string) => ({ id }), accountOf: async () => ACC },
      blockRepository: {
        get: async (ws: string, id: string) => (ws === WS ? (blocksMap.get(id) ?? null) : null),
        findById: async (id: string) => {
          const b = blocksMap.get(id)
          return b ? { workspaceId: WS, serviceId: null, block: b } : null
        },
        listByWorkspace: async (ws: string) => (ws === WS ? [...blocksMap.values()] : []),
        update: async (_ws: string, id: string, patch: Partial<Block>) => {
          const cur = blocksMap.get(id)
          if (cur) blocksMap.set(id, { ...cur, ...patch })
        },
        deleteMany: async (_ws: string, ids: string[]) => {
          for (const id of ids) blocksMap.delete(id)
        },
      },
      serviceRepository: {
        get: async (id: string) => servicesMap.get(id) ?? null,
        getByFrameBlock: async (fb: string) =>
          [...servicesMap.values()].find((s) => s.frameBlockId === fb) ?? null,
        listByFrameBlocks: async (fbs: string[]) =>
          [...servicesMap.values()].filter((s) => fbs.includes(s.frameBlockId)),
        getByRepo: async (inst: number, r: number) =>
          [...servicesMap.values()].find(
            (s) => s.installationId === inst && s.repoGithubId === r,
          ) ?? null,
        deleteMany: async (ids: string[]) => {
          for (const id of ids) servicesMap.delete(id)
        },
      },
      workspaceMountRepository: {
        listWorkspaceIdsMountingBlock: async () => [],
        removeByServices: async (ids: string[]) => {
          for (const [k, m] of mounts) if (ids.includes(m.serviceId)) mounts.delete(k)
        },
      },
      executionRepository: { deleteByBlock: async () => {}, getByBlock: async () => null },
      idGenerator: { next: (prefix: string) => `${prefix}_new` },
      clock: { now: () => 0 },
    } as unknown as BoardServiceDependencies

    return { service: new BoardService(deps), blocksMap, servicesMap }
  }

  function svc(id: string, frameBlockId: string): Service {
    return {
      id,
      accountId: ACC,
      frameBlockId,
      installationId: 100,
      repoGithubId: 200,
      directory: null,
      createdAt: 0,
    }
  }

  it('reclaims the repo-linked service on delete so the repo is re-addable', async () => {
    const { service, servicesMap } = build([frame('f1')], [svc('svc_1', 'f1')])
    await service.removeBlock(WS, 'f1')
    expect(servicesMap.size).toBe(0)
  })

  it('refuses to delete a service that still has unfinished tasks', async () => {
    const { service, blocksMap } = build([
      frame('f1'),
      { ...frame('t1', { level: 'task', parentId: 'f1', status: 'in_progress' }) },
    ])
    await expect(service.removeBlock(WS, 'f1')).rejects.toThrow(/archive it instead/)
    // Nothing was torn down.
    expect(blocksMap.has('f1')).toBe(true)
    expect(blocksMap.has('t1')).toBe(true)
  })

  it('allows deleting a service whose tasks are all done', async () => {
    const { service, blocksMap } = build([
      frame('f1'),
      { ...frame('t1', { level: 'task', parentId: 'f1', status: 'done' }) },
    ])
    await service.removeBlock(WS, 'f1')
    expect(blocksMap.has('f1')).toBe(false)
    expect(blocksMap.has('t1')).toBe(false)
  })

  it('archives a service (sets archived) and restores it (clears archived)', async () => {
    const { service, blocksMap } = build([
      frame('f1'),
      { ...frame('t1', { level: 'task', parentId: 'f1', status: 'in_progress' }) },
    ])
    const archived = await service.archiveBlock(WS, 'f1')
    expect(archived.archived).toBe(true)
    expect(blocksMap.get('f1')?.archived).toBe(true)
    // The subtree is untouched — archive hides, never deletes.
    expect(blocksMap.has('t1')).toBe(true)

    const restored = await service.restoreBlock(WS, 'f1')
    expect(restored.archived).toBe(false)
    expect(blocksMap.get('f1')?.archived).toBe(false)
  })

  it('rejects archiving a non-service block', async () => {
    const { service } = build([
      frame('f1'),
      { ...frame('t1', { level: 'task', parentId: 'f1', status: 'in_progress' }) },
    ])
    await expect(service.archiveBlock(WS, 't1')).rejects.toThrow(/Only a service/)
  })
})
