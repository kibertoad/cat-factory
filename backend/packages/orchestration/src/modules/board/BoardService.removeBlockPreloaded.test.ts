import { describe, expect, it } from 'vitest'
import type { Block, PreloadedBlocks } from '@cat-factory/kernel'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'

// The block-delete path lists the board once during teardown, then hands that list to
// removeBlock so it doesn't pay a SECOND full board read on the same DELETE (perf-tracker
// item 18). The list is reused ONLY when it was loaded for the block's home workspace — a
// mounted shared service homed elsewhere must still re-list against its home.

function frame(id: string): Block {
  return {
    id,
    title: 'Service',
    type: 'service',
    description: '',
    position: { x: 0, y: 0 },
    status: 'ready',
    progress: 0,
    dependsOn: [],
    executionId: null,
    level: 'frame',
    parentId: null,
  }
}

function task(id: string, parentId: string): Block {
  return { ...frame(id), id, title: 'Task', level: 'task', status: 'done', parentId }
}

function build(opts: { local: boolean; blocks: Block[] }) {
  const HOME = 'ws_home'
  const rows = new Map(opts.blocks.map((b) => [b.id, b]))
  let listCount = 0
  const deleted: string[][] = []

  const deps = {
    workspaceRepository: { get: async (id: string) => ({ id }) },
    blockRepository: {
      // Local means the acting workspace homes the block; mounted means it doesn't.
      get: async (ws: string, id: string) =>
        opts.local || ws === HOME ? (rows.get(id) ?? null) : null,
      findById: async (id: string) => {
        const block = rows.get(id)
        return block ? { workspaceId: HOME, serviceId: 'svc', block } : null
      },
      listByWorkspace: async (_ws: string) => {
        listCount += 1
        return [...rows.values()]
      },
      update: async () => {},
      deleteMany: async (_ws: string, ids: string[]) => {
        deleted.push(ids)
        for (const id of ids) rows.delete(id)
      },
    },
    serviceRepository: { getByFrameBlock: async () => null, listByFrameBlocks: async () => [] },
    workspaceMountRepository: {
      get: async (ws: string, serviceId: string) =>
        !opts.local && serviceId === 'svc' ? { workspaceId: ws, serviceId } : null,
      listWorkspaceIdsMountingBlock: async () => [],
    },
    executionRepository: { deleteByBlock: async () => {} },
    idGenerator: { next: (p: string) => `${p}_x` },
    clock: { now: () => 0 },
    executionEventPublisher: {
      async executionChanged() {},
      async boardChanged() {},
      async bootstrapChanged() {},
      async notificationChanged() {},
      async llmCallObserved() {},
    },
  } as unknown as BoardServiceDependencies

  return { service: new BoardService(deps), listCalls: () => listCount, deleted, HOME }
}

describe('BoardService.removeBlock — preloaded block-list reuse (item 18)', () => {
  it('reuses the caller list for a locally-owned block (no second board read)', async () => {
    const blocks = [frame('f1'), task('t1', 'f1')]
    const { service, listCalls, deleted } = build({ local: true, blocks })
    const preloaded: PreloadedBlocks = { workspaceId: 'ws_local', blocks }

    await service.removeBlock('ws_local', 't1', { preloaded })

    // The preloaded list was loaded for the same workspace the block homes to → reused.
    expect(listCalls()).toBe(0)
    expect(deleted).toContainEqual(['t1'])
  })

  it('re-lists when the block homes to a DIFFERENT workspace than the preloaded list', async () => {
    const blocks = [frame('f1'), task('t1', 'f1')]
    const { service, listCalls, deleted, HOME } = build({ local: false, blocks })
    // The caller loaded the list for the acting workspace, but the block homes to HOME.
    const preloaded: PreloadedBlocks = { workspaceId: 'ws_actor', blocks }

    await service.removeBlock('ws_actor', 't1', { preloaded })

    // Mismatched home → the stale acting-workspace list is ignored, HOME is re-listed.
    expect(listCalls()).toBe(1)
    expect(deleted).toContainEqual(['t1'])
    expect(HOME).toBe('ws_home')
  })

  it('still re-lists when no preloaded list is passed (default path unchanged)', async () => {
    const blocks = [frame('f1'), task('t1', 'f1')]
    const { service, listCalls, deleted } = build({ local: true, blocks })

    await service.removeBlock('ws_local', 't1')

    expect(listCalls()).toBe(1)
    expect(deleted).toContainEqual(['t1'])
  })
})
