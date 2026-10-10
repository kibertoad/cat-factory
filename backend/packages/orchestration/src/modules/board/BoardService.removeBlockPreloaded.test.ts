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

// The PREFLIGHT half of the same read. A DELETE is three calls (refuse, tear the runs down, remove),
// and the middle one is irreversible: it kills each container, cancels each durable driver and
// deletes the run rows. A guard that lived only in `removeBlock` therefore answered 422 about a
// board it had already emptied of exactly the history the refusal exists to protect.
describe('BoardService.assertRemovable — the delete preflight', () => {
  it('refuses a service frame that still holds unfinished work, with the machine-readable reason', async () => {
    const open = { ...task('t1', 'f1'), status: 'ready' as const }
    const { service } = build({ local: true, blocks: [frame('f1'), open] })

    await expect(service.assertRemovable('ws_local', 'f1')).rejects.toMatchObject({
      details: { reason: 'service_has_unfinished_tasks', unfinishedTasks: 1 },
    })
  })

  it('hands back the list it decided on, so the whole DELETE still costs ONE board read', async () => {
    // The reason this returns rather than answering void: the teardown and the remove both take it
    // as `preloaded`, so moving the guard earlier costs nothing. A preflight that re-read the board
    // would double every delete on a surface a headless reset drives in a loop.
    const blocks = [frame('f1'), task('t1', 'f1')]
    const { service, listCalls, deleted } = build({ local: true, blocks })

    const preloaded = await service.assertRemovable('ws_local', 'f1')
    await service.removeBlock('ws_local', 'f1', { preloaded })

    expect(preloaded.workspaceId).toBe('ws_local')
    expect(listCalls()).toBe(1)
    expect(deleted[0]).toEqual(expect.arrayContaining(['f1', 't1']))
  })

  it('passes a leaf task through: the guard protects top-level frames only', async () => {
    const open = { ...task('t1', 'f1'), status: 'ready' as const }
    const { service } = build({ local: true, blocks: [frame('f1'), open] })

    await expect(service.assertRemovable('ws_local', 't1')).resolves.toBeDefined()
  })
})
