import type { Block, SourceTask, WorkspaceSnapshot } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { tasksDeps, makeApp } from '../helpers'
import { FakeTaskSourceProvider } from '../fakes/FakeTaskSourceProvider'

describe('create a board task from an imported issue', () => {
  it('materialises a leaf task seeded from the issue and links the issue to it', async () => {
    const jira = new FakeTaskSourceProvider('jira', {
      'PROJ-42': {
        title: 'Add a rate limiter',
        status: 'To Do',
        type: 'Story',
        description: 'Token bucket, 100 rps per tenant.',
      },
    })
    const app = makeApp(undefined, tasksDeps({ providers: [jira] }))
    const { workspace } = await app.createWorkspace({ seed: false })
    const ws = workspace.id

    // A service frame to create the task inside.
    const frame = await app.call<Block>('POST', `/workspaces/${ws}/blocks`, {
      type: 'service',
      position: { x: 0, y: 0 },
    })

    // Connect + import the issue, then turn it into a board task.
    await app.call('POST', `/workspaces/${ws}/task-sources/jira/connect`, {
      credentials: { baseUrl: 'https://acme.atlassian.net', accountEmail: 'd@a.io', apiToken: 't' },
    })
    await app.call('POST', `/workspaces/${ws}/task-sources/jira/import`, { ref: 'PROJ-42' })

    const created = await app.call<{ block: Block; task: SourceTask }>(
      'POST',
      `/workspaces/${ws}/tasks/create-block`,
      { source: 'jira', externalId: 'PROJ-42', containerId: frame.body.id },
    )
    expect(created.status).toBe(201)

    // The new block is a leaf task under the frame, seeded from the issue.
    const block = created.body.block
    expect(block.level).toBe('task')
    expect(block.parentId).toBe(frame.body.id)
    expect(block.title).toContain('PROJ-42')
    expect(block.title).toContain('Add a rate limiter')
    expect(block.description).toContain('Token bucket')
    expect(block.status).toBe('planned')

    // The issue is linked to the new task for context.
    expect(created.body.task.linkedBlockId).toBe(block.id)

    // It's persisted: the board snapshot includes it and the issue list reflects the link.
    const snapshot = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${ws}`)
    expect(snapshot.body.blocks.some((b) => b.id === block.id && b.level === 'task')).toBe(true)
    const issues = await app.call<SourceTask[]>('GET', `/workspaces/${ws}/tasks`)
    expect(issues.body.find((t) => t.externalId === 'PROJ-42')?.linkedBlockId).toBe(block.id)
  })

  it('404s when the issue was never imported', async () => {
    const jira = new FakeTaskSourceProvider('jira')
    const app = makeApp(undefined, tasksDeps({ providers: [jira] }))
    const { workspace } = await app.createWorkspace({ seed: false })
    const ws = workspace.id
    const frame = await app.call<Block>('POST', `/workspaces/${ws}/blocks`, {
      type: 'service',
      position: { x: 0, y: 0 },
    })

    const res = await app.call('POST', `/workspaces/${ws}/tasks/create-block`, {
      source: 'jira',
      externalId: 'PROJ-999',
      containerId: frame.body.id,
    })
    expect(res.status).toBe(404)
  })
})
