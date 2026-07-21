import { afterEach, describe, expect, it } from 'vitest'
import type { Block } from '@cat-factory/kernel'
import {
  clearRegisteredTaskTypeDefaultFragments,
  DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS,
  registerTaskTypeDefaultFragments,
} from '@cat-factory/prompt-fragments'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'

// A task OWNS its best-practice prompt fragment selection from creation. These pin how
// BoardService.addTask derives it: an explicit create-form list is authoritative (honoured as-is,
// including an empty clear); with no list the task INHERITS the enclosing service's standards
// (`serviceFragmentIds`); and a document task always additionally carries the writing-style
// defaults (so a pick/inherit never drops a default). The engine folds exactly this selection —
// it does NOT re-union the service's fragments at run time (see AgentContextBuilder).
describe('BoardService fragment pinning at creation', () => {
  const WS = 'ws_1'

  afterEach(() => clearRegisteredTaskTypeDefaultFragments())

  function build(serviceFragmentIds?: string[]) {
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
      ...(serviceFragmentIds ? { serviceFragmentIds } : {}),
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

  it('seeds a deployment-registered task-type default (e.g. review) onto a new task', async () => {
    registerTaskTypeDefaultFragments('review', ['org.review-checklist'])
    const task = await build().addTask(WS, 'frame_svc', { title: 'Review', taskType: 'review' })
    expect(task.fragmentIds).toEqual(['org.review-checklist'])
  })

  it('unions a registered type default with the inherited service standards (deduped)', async () => {
    registerTaskTypeDefaultFragments('feature', ['org.feature-default'])
    const task = await build(['node.best-practices', 'org.feature-default']).addTask(
      WS,
      'frame_svc',
      { title: 'Feature', taskType: 'feature' },
    )
    expect(task.fragmentIds).toEqual(['node.best-practices', 'org.feature-default'])
  })

  it("inherits the service's standards when the form sends no list", async () => {
    const task = await build(['node.best-practices', 'node.performance']).addTask(WS, 'frame_svc', {
      title: 'Feature',
      taskType: 'feature',
    })
    expect(task.fragmentIds).toEqual(['node.best-practices', 'node.performance'])
  })

  it('an explicit list is authoritative over the inherited standards', async () => {
    const task = await build(['node.best-practices', 'node.performance']).addTask(WS, 'frame_svc', {
      title: 'Feature',
      taskType: 'feature',
      fragmentIds: ['react.hooks'],
    })
    expect(task.fragmentIds).toEqual(['react.hooks'])
  })

  it('an explicit EMPTY list clears the inherited standards (task authoritative)', async () => {
    const task = await build(['node.best-practices']).addTask(WS, 'frame_svc', {
      title: 'Feature',
      taskType: 'feature',
      fragmentIds: [],
    })
    expect(task.fragmentIds).toBeUndefined()
  })
})
