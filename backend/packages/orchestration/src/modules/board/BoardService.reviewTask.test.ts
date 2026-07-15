import { describe, expect, it } from 'vitest'
import type { Block } from '@cat-factory/kernel'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'

// A `review` task targets an EXISTING open PR. BoardService.addTask folds the PR reference
// (URL or #number) and any review focus into the task description, so the read-only
// `pr-reviewer` (which reads the target from its prompt) knows WHICH PR to review. It also
// pins the review task to the PR-review pipeline. These pin that folding + default.
describe('BoardService review-task description folding', () => {
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

  it('folds the PR URL + focus preamble ahead of the description and pins pl_review', async () => {
    const task = await build().addTask(WS, 'frame_svc', {
      title: 'Review the auth PR',
      taskType: 'review',
      description: 'Extra notes.',
      taskTypeFields: {
        prUrl: 'https://github.com/o/r/pull/7',
        reviewFocus: 'the token refresh',
      },
    })
    expect(task.description).toBe(
      'Review pull request https://github.com/o/r/pull/7. Review focus: the token refresh\n\nExtra notes.',
    )
    // A review task defaults to the PR-review pipeline.
    expect(task.pipelineId).toBe('pl_review')
  })

  it('uses #number when only prNumber is given, with no trailing description', async () => {
    const task = await build().addTask(WS, 'frame_svc', {
      title: 'Review PR 42',
      taskType: 'review',
      taskTypeFields: { prNumber: 42 },
    })
    expect(task.description).toBe('Review pull request #42.')
  })

  it('prefers prUrl over prNumber when both are present', async () => {
    const task = await build().addTask(WS, 'frame_svc', {
      title: 'Review',
      taskType: 'review',
      taskTypeFields: { prUrl: 'https://github.com/o/r/pull/9', prNumber: 42 },
    })
    expect(task.description).toBe('Review pull request https://github.com/o/r/pull/9.')
  })
})
