import { describe, expect, it } from 'vitest'
import type { Block, BlueprintService } from '@cat-factory/kernel'
import { BoardService, type BoardServiceDependencies } from '../board/BoardService.js'
import { BoardScanService } from './BoardScanService.js'

// Reconciling a blueprint onto an existing frame adds every missing module. It must do so
// against a SINGLE board read for the whole batch (via BoardService.addModules), not one
// full `listByWorkspace` per module as the old per-module `addModule` loop did — a banned
// N+1 that grows with the module count (perf-tracker item 17). These tests build a real
// BoardService over a counting in-memory block store and drive it through BoardScanService.

const WS = 'ws-1'

function makeScan(initial: Block[]): {
  scan: BoardScanService
  listCalls: () => number
  blocks: () => Block[]
} {
  const rows = new Map<string, Block>(initial.map((b) => [b.id, b]))
  let listCount = 0
  let seq = 0

  const blockRepository = {
    get: async (_ws: string, id: string) => rows.get(id) ?? null,
    findById: async (id: string) => {
      const block = rows.get(id)
      return block ? { workspaceId: WS, serviceId: null, block } : null
    },
    listByWorkspace: async (_ws: string) => {
      listCount += 1
      return [...rows.values()]
    },
    insert: async (_ws: string, block: Block) => {
      rows.set(block.id, block)
    },
    update: async (_ws: string, id: string, patch: Partial<Block>) => {
      const cur = rows.get(id)
      if (cur) rows.set(id, { ...cur, ...patch })
    },
    setService: async () => {},
    deleteMany: async () => {},
  }

  const deps = {
    workspaceRepository: { get: async (id: string) => ({ id }) },
    blockRepository,
    serviceRepository: { getByFrameBlock: async () => null },
    workspaceMountRepository: { get: async () => null },
    executionRepository: {},
    idGenerator: { next: (prefix: string) => `${prefix}_${seq++}` },
    clock: { now: () => 0 },
    executionEventPublisher: {
      async executionChanged() {},
      async boardChanged() {},
      async bootstrapChanged() {},
      async notificationChanged() {},
      async llmCallObserved() {},
    },
  } as unknown as BoardServiceDependencies

  const scan = new BoardScanService({
    boardService: new BoardService(deps),
    blockRepository: blockRepository as never,
  })
  return { scan, listCalls: () => listCount, blocks: () => [...rows.values()] }
}

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

function moduleBlock(id: string, parentId: string, title: string): Block {
  return { ...frame(id), id, title, level: 'module', parentId }
}

function blueprint(modules: Array<{ name: string; summary?: string }>): BlueprintService {
  return {
    name: 'Service',
    type: 'service',
    summary: '',
    references: [],
    modules: modules.map((m) => ({
      name: m.name,
      summary: m.summary ?? '',
      references: [],
    })),
  } as unknown as BlueprintService
}

describe('BoardScanService.reconcileBlueprint — batched module insert (item 17)', () => {
  it('adds all missing modules with ONE board list for the whole batch', async () => {
    const board = makeScan([frame('frame-1')])

    const before = board.listCalls()
    const result = await board.scan.reconcileBlueprint(
      WS,
      'frame-1',
      blueprint([{ name: 'Auth' }, { name: 'Billing' }, { name: 'Search' }]),
    )
    // The batch adds exactly one workspace list for the three new modules (plus the one
    // reconcile itself takes), NOT one per module.
    expect(board.listCalls() - before).toBe(2)

    expect(result).toEqual({ frameId: 'frame-1', modules: 3 })
    const created = board.blocks().filter((b) => b.level === 'module')
    expect(created.map((b) => b.title).sort()).toEqual(['Auth', 'Billing', 'Search'])
  })

  it('matches existing modules by name, adds only the missing ones, and refreshes descriptions', async () => {
    const board = makeScan([frame('frame-1'), moduleBlock('mod-existing', 'frame-1', 'Auth')])

    const result = await board.scan.reconcileBlueprint(
      WS,
      'frame-1',
      blueprint([
        { name: 'auth', summary: 'Authentication and sessions.' }, // case-insensitive match
        { name: 'Billing', summary: 'Invoicing.' },
      ]),
    )

    expect(result.modules).toBe(2)
    const modules = board.blocks().filter((b: Block) => b.level === 'module')
    // The existing Auth block is reused (not duplicated); Billing is created.
    expect(modules).toHaveLength(2)
    const auth = modules.find((b) => b.title === 'Auth')
    expect(auth?.id).toBe('mod-existing')
    expect(auth?.description).toContain('Authentication and sessions.')
  })
})
