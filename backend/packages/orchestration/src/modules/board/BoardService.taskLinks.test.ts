import { describe, expect, it } from 'vitest'
import type { Block } from '@cat-factory/kernel'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'

// Deleting a block must clear the `linked_block_id` of every tracker issue filed as it, over the
// WHOLE doomed subtree: the documents rule applied to the other table carrying a single link.
// Left stale, the link takes the ticket out of circulation for good: the bug-intake sweep excludes
// it forever and `claimBlockLink` refuses every future filing of it. Nothing is deleted: the issue
// projection outlives the task, which is what lets the ticket be re-filed.
describe('BoardService.removeBlock: tracker issue link cascade', () => {
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
    // `done` so the frame-level delete below isn't refused by the "archive a service with
    // unfinished work" guard, which has nothing to do with what these tests pin.
    const task: Block = {
      ...frame,
      id: 'task_1',
      title: 'Filed',
      level: 'task',
      parentId: frame.id,
      status: 'done',
    }
    const other: Block = { ...task, id: 'task_2', title: 'Untouched' }
    const byId = new Map([frame, task, other].map((b) => [b.id, b]))
    // The projection rows, keyed as the repo keys them, so a detach that widened past the named
    // blocks would be visible here.
    const links = new Map<string, string | null>([
      ['jira:PROJ-1', 'task_1'],
      ['github:octo/repo#2', 'task_2'],
    ])
    const detachCalls: string[][] = []
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
      taskRepository: {
        unlinkAllFromBlocks: async (_ws: string, blockIds: readonly string[]) => {
          detachCalls.push([...blockIds])
          for (const [key, blockId] of links) {
            if (blockId && blockIds.includes(blockId)) links.set(key, null)
          }
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
    return { service: new BoardService(deps), links, detachCalls }
  }

  it("detaches the deleted task's issue and leaves every other link alone", async () => {
    const { service, links } = build()
    await service.removeBlock(WS, 'task_1')
    expect(links.get('jira:PROJ-1')).toBeNull()
    expect(links.get('github:octo/repo#2')).toBe('task_2')
    // The issue rows themselves are untouched: only the link went, so the ticket can be re-filed.
    expect([...links.keys()].sort()).toEqual(['github:octo/repo#2', 'jira:PROJ-1'])
  })

  it('detaches the whole doomed subtree in ONE batched write, not a detach per block', async () => {
    const { service, links, detachCalls } = build()
    // Deleting the frame cascades over both tasks under it.
    await service.removeBlock(WS, 'frame_1')
    expect(links.get('jira:PROJ-1')).toBeNull()
    expect(links.get('github:octo/repo#2')).toBeNull()
    expect(detachCalls).toHaveLength(1)
    expect(new Set(detachCalls[0])).toEqual(new Set(['frame_1', 'task_1', 'task_2']))
  })

  it("includes the deleted id itself, so a DANGLING block's issue is detached too", async () => {
    const { service, detachCalls } = build()
    // The block row is already gone (so it is absent from the listed blocks) while its issue link
    // lives on, which is the case the cascade would otherwise miss entirely.
    await service.removeBlock(WS, 'task_gone')
    expect(detachCalls).toHaveLength(1)
    expect(detachCalls[0]).toContain('task_gone')
  })
})
