import { UNATTRIBUTED_BLOCK_EDIT_AUTHORITY } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import type { Block } from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'

// A task may live ONLY under a service frame or a module — the same rule `canReparent` enforces
// on a move, applied at CREATE. It used to hold only on the move path (`addTask` merely refused a
// `task` container), so a create could park a task under an `epic`/`initiative` grouping node,
// where every reader that resolves a service subtree STRUCTURALLY silently loses it: the public
// API's `listServiceTasks` reads "parented by the frame, or by a module of the frame" in one SQL
// query and is exhaustive only because of this invariant.
describe('BoardService.addTask containment rule', () => {
  const WS = 'ws_1'

  function container(id: string, level: Block['level']): Block {
    return {
      id,
      title: id,
      type: 'service',
      description: '',
      position: { x: 0, y: 0 },
      status: 'ready',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level,
      parentId: level === 'frame' ? null : 'frame_svc',
    }
  }

  function build() {
    const byId = new Map<string, Block>(
      (
        [
          ['frame_svc', 'frame'],
          ['mod_api', 'module'],
          ['epic_q3', 'epic'],
          ['init_loop', 'initiative'],
          ['task_existing', 'task'],
        ] as [string, Block['level']][]
      ).map(([id, level]) => [id, container(id, level)]),
    )
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

  it('creates a task under a service frame and under a module', async () => {
    for (const parent of ['frame_svc', 'mod_api']) {
      const task = await build().addTask(
        WS,
        parent,
        { title: 'Feature' },
        UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
      )
      expect(task).toMatchObject({ level: 'task', parentId: parent })
    }
  })

  it('refuses a grouping node as the container', async () => {
    // An epic/initiative groups tasks through their `epicId`/`initiativeId` membership link, never
    // through parentage — a task parented to one would be structurally orphaned.
    for (const parent of ['epic_q3', 'init_loop']) {
      await expect(
        build().addTask(WS, parent, { title: 'Feature' }, UNATTRIBUTED_BLOCK_EDIT_AUTHORITY),
      ).rejects.toBeInstanceOf(ValidationError)
    }
  })

  it('still refuses a task as the container, with its own message', async () => {
    await expect(
      build().addTask(WS, 'task_existing', { title: 'Nested' }, UNATTRIBUTED_BLOCK_EDIT_AUTHORITY),
    ).rejects.toThrow(/cannot contain other tasks/i)
  })
})
