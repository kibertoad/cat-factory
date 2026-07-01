import { describe, expect, it } from 'vitest'
import type { Block } from '@cat-factory/kernel'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'

// A `document` repository frame is authored, not implemented: BoardService.addTask must accept
// only document/spike tasks under it and reject the code-producing kinds (feature/bug), so the
// board never holds an un-runnable task under a doc frame.
describe('BoardService document-repository task gating', () => {
  const WS = 'ws_1'

  function build(frameType: Block['type']) {
    const frame: Block = {
      id: 'frame_docs',
      title: 'Docs',
      type: frameType,
      description: '',
      position: { x: 0, y: 0 },
      status: 'ready',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'frame',
      parentId: null,
    }
    const byId = new Map([[frame.id, frame]])
    const deps = {
      workspaceRepository: { get: async (id: string) => ({ id }) },
      blockRepository: {
        get: async (ws: string, id: string) => (ws === WS ? (byId.get(id) ?? null) : null),
        findById: async (id: string) => {
          const block = byId.get(id)
          return block ? { workspaceId: WS, serviceId: null, block } : null
        },
        listByWorkspace: async (ws: string) => (ws === WS ? [...byId.values()] : []),
        insert: async () => {},
      },
      serviceRepository: { getByFrameBlock: async () => null },
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
    return new BoardService(deps)
  }

  it('rejects a feature task under a document repository', async () => {
    const service = build('document')
    await expect(
      service.addTask(WS, 'frame_docs', { title: 'Ship it', taskType: 'feature' }),
    ).rejects.toThrow(/document repository only accepts document or spike/i)
  })

  it('accepts a document task under a document repository', async () => {
    const service = build('document')
    const task = await service.addTask(WS, 'frame_docs', {
      title: 'Write the RFC',
      taskType: 'document',
    })
    expect(task.taskType).toBe('document')
  })

  it('accepts a spike task under a document repository', async () => {
    const service = build('document')
    const task = await service.addTask(WS, 'frame_docs', {
      title: 'Investigate',
      taskType: 'spike',
    })
    expect(task.taskType).toBe('spike')
  })

  it('still accepts a feature task under a normal service frame', async () => {
    const service = build('service')
    const task = await service.addTask(WS, 'frame_docs', {
      title: 'Add endpoint',
      taskType: 'feature',
    })
    expect(task.taskType).toBe('feature')
  })
})
