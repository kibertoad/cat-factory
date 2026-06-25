import type { Block, TaskContent, TaskDependencyLink } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { TaskLinkService } from './TaskLinkService.js'

// Minimal Block factory — only the fields spawnEpic / the board fakes read.
function block(id: string, over: Partial<Block> = {}): Block {
  return {
    id,
    title: id,
    type: 'service',
    description: '',
    position: { x: 0, y: 0 },
    status: 'planned',
    progress: 0,
    dependsOn: [],
    executionId: null,
    level: 'task',
    parentId: null,
    ...over,
  }
}

function content(externalId: string, over: Partial<TaskContent> = {}): TaskContent {
  return {
    externalId,
    url: `https://example.test/${externalId}`,
    title: externalId,
    status: 'open',
    type: 'Task',
    assignee: null,
    priority: null,
    labels: [],
    description: '',
    comments: [],
    ...over,
  }
}

/**
 * A board fake that stores blocks in one map and implements `toggleDependency` with the
 * REAL toggle semantics (add when absent, remove when present) so a regression that seeds
 * the same edge twice would surface as a cancelled (missing) edge.
 */
function fakeBoard() {
  const blocks = new Map<string, Block>()
  let n = 0
  return {
    blocks,
    async addEpic(_ws: string, input: { title: string; description?: string }) {
      const b = block(`epic_${++n}`, { level: 'epic', title: input.title })
      blocks.set(b.id, b)
      return b
    },
    async addTask(_ws: string, containerId: string, input: { title: string; epicId?: string }) {
      const b = block(`task_${++n}`, {
        level: 'task',
        title: input.title,
        parentId: containerId,
        epicId: input.epicId,
      })
      blocks.set(b.id, b)
      return b
    },
    async toggleDependency(_ws: string, targetId: string, sourceId: string) {
      const target = blocks.get(targetId)!
      const i = target.dependsOn.indexOf(sourceId)
      target.dependsOn =
        i >= 0 ? target.dependsOn.filter((d) => d !== sourceId) : [...target.dependsOn, sourceId]
      return target
    },
  }
}

function makeService(opts: {
  board: ReturnType<typeof fakeBoard>
  contents: Record<string, TaskContent>
  container: Block
}) {
  const blockRepository = {
    async get(_ws: string, id: string) {
      return id === opts.container.id ? opts.container : (opts.board.blocks.get(id) ?? null)
    },
  }
  const taskRepository = {
    async get() {
      return null // nothing pre-linked
    },
    async linkBlock() {},
  }
  const importService = {
    async importDetailed(_ws: string, _source: string, ref: string) {
      const c = opts.contents[ref]
      if (!c) throw new Error(`no content for ${ref}`)
      return { task: {}, content: c }
    },
  }
  return new TaskLinkService({
    boardService: opts.board as never,
    blockRepository: blockRepository as never,
    taskRepository: taskRepository as never,
    importService: importService as never,
  })
}

describe('TaskLinkService.spawnEpic dependency seeding', () => {
  it('seeds a single edge for a relationship represented on BOTH endpoints', async () => {
    // A blocks B: A declares the outward "blocks", B declares the inward "blocked by".
    // Both map to the same directed edge (B dependsOn A); a naive toggle-per-link cancels it.
    const board = fakeBoard()
    const container = block('frame_1', { level: 'frame' })
    const linksA: TaskDependencyLink[] = [{ type: 'blocks', externalId: 'B' }]
    const linksB: TaskDependencyLink[] = [{ type: 'blockedBy', externalId: 'A' }]
    const svc = makeService({
      board,
      container,
      contents: {
        EPIC: content('EPIC', { childExternalIds: ['A', 'B'] }),
        A: content('A', { links: linksA }),
        B: content('B', { links: linksB }),
      },
    })

    const { tasks } = await svc.spawnEpic('ws', 'jira', 'EPIC', container.id)

    // Tasks are titled `${externalId}: ${title}` ("A: A" / "B: B").
    const a = tasks.find((t) => t.title.startsWith('A:'))!
    const b = tasks.find((t) => t.title.startsWith('B:'))!
    // The edge must survive: B dependsOn A (B is blocked by A).
    expect(board.blocks.get(b.id)!.dependsOn).toEqual([a.id])
    expect(board.blocks.get(a.id)!.dependsOn).toEqual([])
  })

  it('does not seed edges for issues outside the imported set, or for relates', async () => {
    const board = fakeBoard()
    const container = block('frame_1', { level: 'frame' })
    const svc = makeService({
      board,
      container,
      contents: {
        EPIC: content('EPIC', { childExternalIds: ['A'] }),
        A: content('A', {
          links: [
            { type: 'blockedBy', externalId: 'OUTSIDE' }, // not imported → skipped
            { type: 'relates', externalId: 'A' }, // relates → ignored for sequencing
          ],
        }),
      },
    })

    const { tasks } = await svc.spawnEpic('ws', 'jira', 'EPIC', container.id)
    expect(board.blocks.get(tasks[0]!.id)!.dependsOn).toEqual([])
  })
})
