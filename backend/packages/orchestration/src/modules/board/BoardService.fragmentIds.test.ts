import { describe, expect, it } from 'vitest'
import type { Block } from '@cat-factory/kernel'
import { DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS } from '@cat-factory/prompt-fragments'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'

// A task can pin best-practice prompt fragments at creation (chosen on the create form). These
// pin how BoardService.addTask persists that selection: honoured as-is for a normal task, and
// unioned with the writing-style defaults for a document task (so a pick never drops a default).
describe('BoardService fragment pinning at creation', () => {
  const WS = 'ws_1'

  function build() {
    const frame: Block = {
      id: 'frame_svc',
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
    const byId = new Map([[frame.id, frame]])
    const deps = {
      workspaceRepository: { get: async (id: string) => ({ id }) },
      blockRepository: {
        get: async (ws: string, id: string) => (ws === WS ? (byId.get(id) ?? null) : null),
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

  it('persists the picked fragments on a normal task', async () => {
    const task = await build().addTask(WS, 'frame_svc', {
      title: 'Feature',
      taskType: 'feature',
      fragmentIds: ['node.errors', 'react.hooks'],
    })
    expect(task.fragmentIds).toEqual(['node.errors', 'react.hooks'])
  })

  it('leaves fragmentIds unset when none are picked', async () => {
    const task = await build().addTask(WS, 'frame_svc', { title: 'Feature', taskType: 'feature' })
    expect(task.fragmentIds).toBeUndefined()
  })

  it('unions the picked fragments with the document writing-style defaults', async () => {
    const task = await build().addTask(WS, 'frame_svc', {
      title: 'Doc',
      taskType: 'document',
      fragmentIds: ['style.anti-llmisms', 'doc.structure'],
    })
    // The default style ids are present exactly once (deduped) alongside the extra pick.
    expect(new Set(task.fragmentIds)).toEqual(
      new Set([...DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS, 'doc.structure']),
    )
    expect(task.fragmentIds).toHaveLength(DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS.length + 1)
  })

  it('still applies the document defaults when nothing is picked', async () => {
    const task = await build().addTask(WS, 'frame_svc', { title: 'Doc', taskType: 'document' })
    expect(task.fragmentIds).toEqual([...DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS])
  })
})
