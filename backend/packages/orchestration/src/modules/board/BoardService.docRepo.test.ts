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

  it('pre-selects the writing-style fragments on a new document task (default-on)', async () => {
    // A document task starts with the universal style fragments pinned so the `doc-aware`
    // authoring/review kinds fold them in by default; the user can remove them like any pin.
    const service = build('document')
    const task = await service.addTask(WS, 'frame_docs', {
      title: 'Write the RFC',
      taskType: 'document',
    })
    expect(task.fragmentIds).toEqual(['style.anti-llmisms', 'style.concise-actionable'])
  })

  it('accepts a spike task under a document repository', async () => {
    const service = build('document')
    const task = await service.addTask(WS, 'frame_docs', {
      title: 'Investigate',
      taskType: 'spike',
    })
    expect(task.taskType).toBe('spike')
    // A non-document task carries no default style pins.
    expect(task.fragmentIds).toBeUndefined()
  })

  it('still accepts a feature task under a normal service frame', async () => {
    const service = build('service')
    const task = await service.addTask(WS, 'frame_docs', {
      title: 'Add endpoint',
      taskType: 'feature',
    })
    expect(task.taskType).toBe('feature')
    expect(task.fragmentIds).toBeUndefined()
  })
})

// The doc-repo gate must also hold on drag-drop: reparent is a second way a task enters a frame,
// so a feature/bug task must not be moveable into a document frame, and a task's behavioural
// `type` must be re-stamped to its new enclosing frame.
describe('BoardService document-repository reparent gating', () => {
  const WS = 'ws_1'

  function frame(id: string, type: Block['type']): Block {
    return {
      id,
      title: id,
      type,
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

  function build(taskType: Block['taskType']) {
    const svc = frame('frame_svc', 'service')
    const doc = frame('frame_docs', 'document')
    const task: Block = {
      id: 'task_1',
      title: 'A task',
      type: 'service',
      description: '',
      position: { x: 0, y: 0 },
      status: 'planned',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'task',
      parentId: svc.id,
      taskType,
    }
    const byId = new Map([svc, doc, task].map((b) => [b.id, b]))
    const patches: { id: string; patch: Partial<Block> }[] = []
    const deps = {
      workspaceRepository: { get: async (id: string) => ({ id }) },
      blockRepository: {
        get: async (ws: string, id: string) => (ws === WS ? (byId.get(id) ?? null) : null),
        listByWorkspace: async (ws: string) => (ws === WS ? [...byId.values()] : []),
        update: async (_ws: string, id: string, patch: Partial<Block>) => {
          patches.push({ id, patch })
        },
        setService: async () => {},
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
    return { service: new BoardService(deps), patches }
  }

  it('rejects dragging a feature task into a document repository', async () => {
    const { service } = build('feature')
    await expect(
      service.reparent(WS, 'task_1', { parentId: 'frame_docs', position: { x: 1, y: 1 } }),
    ).rejects.toThrow(/document repository only accepts document or spike/i)
  })

  it('allows a document task into a document repository and re-stamps its type', async () => {
    const { service, patches } = build('document')
    await service.reparent(WS, 'task_1', { parentId: 'frame_docs', position: { x: 1, y: 1 } })
    const patch = patches.find((p) => p.id === 'task_1')?.patch
    expect(patch?.parentId).toBe('frame_docs')
    expect(patch?.type).toBe('document')
  })
})
