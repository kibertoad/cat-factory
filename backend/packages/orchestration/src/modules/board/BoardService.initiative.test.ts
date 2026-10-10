import { describe, expect, it } from 'vitest'
import type { Block, Initiative } from '@cat-factory/kernel'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'

// Deleting an `initiative`-level block must also delete its 1:1 `initiatives` entity, the same
// way a doomed service frame's account-owned service is reclaimed. Otherwise the row survives as
// a phantom in the snapshot with its slug reserved forever (and slice 3's sweeper would re-drive
// a dead initiative). This pins the cascade so a facade can't regress it.
describe('BoardService.removeBlock — initiative entity cascade', () => {
  const WS = 'ws_1'

  function build() {
    const frame: Block = {
      id: 'frame_1',
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
    const initiativeBlock: Block = {
      ...frame,
      id: 'init_block',
      title: 'Migrate',
      level: 'initiative',
      parentId: frame.id,
    }
    const byId = new Map([frame, initiativeBlock].map((b) => [b.id, b]))
    const entity: Initiative = {
      id: 'initv_1',
      blockId: initiativeBlock.id,
      slug: 'migrate',
      title: 'Migrate',
      goal: '',
      constraints: [],
      nonGoals: [],
      qa: [],
      analysisSummary: '',
      phases: [],
      items: [],
      policy: null,
      decisions: [],
      deviations: [],
      followUps: [],
      caveats: [],
      status: 'planning',
      rev: 0,
      createdAt: 1,
      updatedAt: 1,
    }
    const initiatives = new Map([[entity.id, entity]])
    const deleted: string[] = []
    const deps = {
      workspaceRepository: { get: async (id: string) => ({ id }) },
      blockRepository: {
        get: async (ws: string, id: string) => (ws === WS ? (byId.get(id) ?? null) : null),
        listByWorkspace: async (ws: string) => (ws === WS ? [...byId.values()] : []),
        deleteMany: async (_ws: string, ids: string[]) => {
          for (const id of ids) byId.delete(id)
        },
        update: async () => {},
      },
      executionRepository: { deleteByBlock: async () => {} },
      initiativeRepository: {
        list: async (ws: string) => (ws === WS ? [...initiatives.values()] : []),
        delete: async (_ws: string, id: string) => {
          deleted.push(id)
          initiatives.delete(id)
        },
      },
      idGenerator: { next: (prefix: string) => `${prefix}_new` },
      clock: { now: () => 0 },
      executionEventPublisher: {
        async executionChanged() {},
        async boardChanged() {},
        async bootstrapChanged() {},
        async notificationChanged() {},
        async llmCallObserved() {},
      },
    } as unknown as BoardServiceDependencies
    return { service: new BoardService(deps), deleted, initiatives }
  }

  it('deletes the initiative entity anchored to a removed initiative block', async () => {
    const { service, deleted, initiatives } = build()
    await service.removeBlock(WS, 'init_block')
    expect(deleted).toEqual(['initv_1'])
    expect(initiatives.size).toBe(0)
  })

  it('leaves unrelated initiatives untouched when a non-initiative block is removed', async () => {
    const { service, deleted } = build()
    // Removing the frame cascades to the initiative block underneath it, so its entity still goes;
    // but removing a leaf that anchors no initiative must delete nothing.
    await service.removeBlock(WS, 'frame_1')
    expect(deleted).toEqual(['initv_1'])
  })
})
