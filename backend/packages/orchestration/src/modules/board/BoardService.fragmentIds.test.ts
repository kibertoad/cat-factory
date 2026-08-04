import { afterEach, describe, expect, it } from 'vitest'
import type { Block, TaskTypeRegistry } from '@cat-factory/kernel'
import { defaultTaskTypeRegistry } from '@cat-factory/kernel'
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

  function build(serviceFragmentIds?: string[], taskTypeRegistry?: TaskTypeRegistry) {
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
      ...(taskTypeRegistry ? { taskTypeRegistry } : {}),
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

  // A REUSABLE OPERATION's standing context: the registered type's own `defaultFragmentIds`. This
  // is what makes the operation consistent invocation after invocation, and it is a DESCRIPTOR
  // field rather than the module-global `registerTaskTypeDefaultFragments` seam, so the whole
  // bundle (form + standing context + pipeline) is declared in one place.
  describe("a registered custom type's own defaultFragmentIds", () => {
    function withOperation(serviceFragmentIds?: string[]) {
      const registry = defaultTaskTypeRegistry()
      registry.register({
        taskType: 'org:introduce-api',
        presentation: {
          label: 'Introduce API',
          icon: 'i-lucide-plug',
          color: '#0ea5e9',
          description: 'Expose functionality over HTTP.',
        },
        defaultFragmentIds: ['org.api-guidelines', 'org.api-auth-requirements'],
      })
      return build(serviceFragmentIds, registry)
    }

    it('seeds them onto a new task of that type', async () => {
      const task = await withOperation().addTask(WS, 'frame_svc', {
        title: 'Expose orders',
        taskType: 'org:introduce-api',
      })
      expect(task.fragmentIds).toEqual(['org.api-guidelines', 'org.api-auth-requirements'])
    })

    it('unions them with the inherited service standards, deduped', async () => {
      const task = await withOperation(['node.best-practices', 'org.api-guidelines']).addTask(
        WS,
        'frame_svc',
        { title: 'Expose orders', taskType: 'org:introduce-api' },
      )
      expect(task.fragmentIds).toEqual([
        'node.best-practices',
        'org.api-guidelines',
        'org.api-auth-requirements',
      ])
    })

    it('applies them even when the create form pins its own picks', async () => {
      // An explicit list is authoritative over what the task INHERITS, but the operation's
      // standing context is part of the type, not something a picker chose to include.
      const task = await withOperation().addTask(WS, 'frame_svc', {
        title: 'Expose orders',
        taskType: 'org:introduce-api',
        fragmentIds: ['react.hooks'],
      })
      expect(task.fragmentIds).toEqual([
        'react.hooks',
        'org.api-guidelines',
        'org.api-auth-requirements',
      ])
    })

    it('leaves a task of any other type untouched', async () => {
      const task = await withOperation().addTask(WS, 'frame_svc', {
        title: 'Feature',
        taskType: 'feature',
      })
      expect(task.fragmentIds).toBeUndefined()
    })
  })
})
