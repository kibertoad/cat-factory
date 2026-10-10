import type { Block, TaskRecord } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { TaskLinkService } from './TaskLinkService.js'

// Minimal Block factory — only the fields replaceForBlock reads.
function block(id: string): Block {
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
  }
}

function record(externalId: string, linkedBlockId: string | null = null): TaskRecord {
  return {
    workspaceId: 'ws',
    source: 'jira',
    externalId,
    title: externalId,
    url: `https://example.test/browse/${externalId}`,
    status: 'To Do',
    type: 'Bug',
    assignee: null,
    priority: null,
    labels: [],
    description: '',
    comments: [],
    excerpt: '',
    linkedBlockId,
    syncedAt: 0,
    deletedAt: null,
  }
}

/**
 * An in-memory task projection implementing the link/unlink semantics for real,
 * so the test asserts the OUTCOME (exactly one linked issue after a replace),
 * not just that some methods were called.
 */
function makeService(records: TaskRecord[], knownBlocks: string[]) {
  const store = new Map(records.map((r) => [`${r.source}:${r.externalId}`, { ...r }]))
  const taskRepository = {
    async get(_ws: string, source: string, externalId: string) {
      return store.get(`${source}:${externalId}`) ?? null
    },
    async linkBlock(_ws: string, source: string, externalId: string, blockId: string | null) {
      const row = store.get(`${source}:${externalId}`)
      if (row) row.linkedBlockId = blockId
    },
    async unlinkAllFromBlock(_ws: string, blockId: string) {
      for (const row of store.values()) {
        if (row.linkedBlockId === blockId) row.linkedBlockId = null
      }
    },
  }
  const blockRepository = {
    async get(_ws: string, id: string) {
      return knownBlocks.includes(id) ? block(id) : null
    },
  }
  const svc = new TaskLinkService({
    boardService: {} as never,
    blockRepository: blockRepository as never,
    taskRepository: taskRepository as never,
    importService: {} as never,
  })
  const linkedTo = (blockId: string) =>
    [...store.values()].filter((r) => r.linkedBlockId === blockId).map((r) => r.externalId)
  return { svc, linkedTo }
}

describe('TaskLinkService.replaceForBlock', () => {
  it('unlinks the previous fire’s issue(s) before linking the new one', async () => {
    const { svc, linkedTo } = makeService(
      [record('PROJ-1', 'blk_recurring'), record('PROJ-2', 'blk_recurring'), record('PROJ-3')],
      ['blk_recurring'],
    )

    const linked = await svc.replaceForBlock('ws', 'blk_recurring', 'jira', 'PROJ-3')

    // Exactly the new issue is linked — earlier fires' links never accumulate.
    expect(linkedTo('blk_recurring')).toEqual(['PROJ-3'])
    expect(linked.linkedBlockId).toBe('blk_recurring')
  })

  it('does not disturb issues linked to OTHER blocks', async () => {
    const { svc, linkedTo } = makeService(
      [record('PROJ-1', 'blk_other'), record('PROJ-2')],
      ['blk_recurring', 'blk_other'],
    )

    await svc.replaceForBlock('ws', 'blk_recurring', 'jira', 'PROJ-2')

    expect(linkedTo('blk_other')).toEqual(['PROJ-1'])
    expect(linkedTo('blk_recurring')).toEqual(['PROJ-2'])
  })

  it('404s on an unknown block without touching any link', async () => {
    const { svc, linkedTo } = makeService([record('PROJ-1', 'blk_recurring')], [])

    await expect(svc.replaceForBlock('ws', 'blk_recurring', 'jira', 'PROJ-1')).rejects.toThrow()
    expect(linkedTo('blk_recurring')).toEqual(['PROJ-1'])
  })

  it('404s on an unimported issue without unlinking the current one', async () => {
    const { svc, linkedTo } = makeService([record('PROJ-1', 'blk_recurring')], ['blk_recurring'])

    await expect(svc.replaceForBlock('ws', 'blk_recurring', 'jira', 'NOPE-9')).rejects.toThrow()
    expect(linkedTo('blk_recurring')).toEqual(['PROJ-1'])
  })
})
