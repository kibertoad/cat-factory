import type { SourceTask, TaskConnection, TaskSourceDescriptor } from '@cat-factory/core'
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { tasksDeps, makeApp } from '../helpers'
import { FakeAgentExecutor } from '../fakes/FakeAgentExecutor'
import { FakeTaskSourceProvider } from '../fakes/FakeTaskSourceProvider'

const jiraCreds = {
  baseUrl: 'https://acme.atlassian.net',
  accountEmail: 'dev@acme.io',
  apiToken: 'secret-token',
}

describe('task source connect + import', () => {
  it('lists the configured sources with their connect metadata', async () => {
    const app = makeApp(new FakeAgentExecutor(), tasksDeps())
    const { workspace } = await app.createWorkspace({ seed: false })

    const res = await app.call<{ sources: TaskSourceDescriptor[] }>(
      'GET',
      `/workspaces/${workspace.id}/task-sources`,
    )
    expect(res.status).toBe(200)
    expect(res.body.sources.map((s) => s.source)).toEqual(['jira'])
    const jira = res.body.sources.find((s) => s.source === 'jira')!
    expect(jira.credentialFields.map((f) => f.key)).toContain('apiToken')
  })

  it('connects a source and reads it back without leaking credentials', async () => {
    const app = makeApp(new FakeAgentExecutor(), tasksDeps())
    const { workspace } = await app.createWorkspace({ seed: false })

    const connected = await app.call<TaskConnection>(
      'POST',
      `/workspaces/${workspace.id}/task-sources/jira/connect`,
      { credentials: jiraCreds },
    )
    expect(connected.status).toBe(201)
    expect(connected.body.source).toBe('jira')
    expect((connected.body as Record<string, unknown>).credentials).toBeUndefined()
    expect((connected.body as Record<string, unknown>).apiToken).toBeUndefined()

    const read = await app.call<{ connections: TaskConnection[] }>(
      'GET',
      `/workspaces/${workspace.id}/task-sources/connections`,
    )
    expect(read.body.connections.map((c) => c.source)).toEqual(['jira'])
  })

  it('imports an issue as a structured projection and preserves the link on re-import', async () => {
    const jira = new FakeTaskSourceProvider('jira', {
      'PROJ-1': {
        title: 'Add rate limiter',
        status: 'In Progress',
        type: 'Story',
        assignee: 'Jane Doe',
        priority: 'High',
        labels: ['api', 'urgent'],
        description: 'Token bucket, 100 rps per tenant.',
        comments: [{ author: 'John', createdAt: '2026-06-10T09:00:00.000Z', body: 'ship it' }],
      },
    })
    const app = makeApp(new FakeAgentExecutor(), tasksDeps({ providers: [jira] }))
    const { workspace } = await app.createWorkspace({ seed: false })
    const ws = workspace.id

    await app.call('POST', `/workspaces/${ws}/task-sources/jira/connect`, {
      credentials: jiraCreds,
    })

    const imported = await app.call<SourceTask>(
      'POST',
      `/workspaces/${ws}/task-sources/jira/import`,
      {
        ref: 'PROJ-1',
      },
    )
    expect(imported.status).toBe(201)
    expect(imported.body.externalId).toBe('PROJ-1')
    expect(imported.body.status).toBe('In Progress')
    expect(imported.body.type).toBe('Story')
    expect(imported.body.assignee).toBe('Jane Doe')
    expect(imported.body.labels).toEqual(['api', 'urgent'])
    expect(imported.body.comments.map((c) => c.body)).toContain('ship it')
    expect(imported.body.excerpt).toContain('Token bucket')

    // Link to a block, then re-import; the link survives.
    const frame = await app.call<{ id: string }>('POST', `/workspaces/${ws}/blocks`, {
      type: 'service',
      position: { x: 0, y: 0 },
    })
    const task = await app.call<{ id: string }>(
      'POST',
      `/workspaces/${ws}/blocks/${frame.body.id}/tasks`,
      { title: 'Implement limiter' },
    )
    await app.call('POST', `/workspaces/${ws}/tasks/link`, {
      source: 'jira',
      externalId: 'PROJ-1',
      blockId: task.body.id,
    })
    const reimported = await app.call<SourceTask>(
      'POST',
      `/workspaces/${ws}/task-sources/jira/import`,
      { ref: 'PROJ-1' },
    )
    expect(reimported.body.linkedBlockId).toBe(task.body.id)

    const listed = await app.call<SourceTask[]>('GET', `/workspaces/${ws}/tasks`)
    expect(listed.body.map((t) => t.externalId)).toEqual(['PROJ-1'])
  })

  it('stores source credentials encrypted at rest and round-trips them on import', async () => {
    const jira = new FakeTaskSourceProvider('jira')
    const app = makeApp(new FakeAgentExecutor(), tasksDeps({ providers: [jira] }))
    const { workspace } = await app.createWorkspace({ seed: false })
    const ws = workspace.id

    await app.call('POST', `/workspaces/${ws}/task-sources/jira/connect`, {
      credentials: { ...jiraCreds, apiToken: 'jira_super_secret_value' },
    })

    const row = await env.DB.prepare(
      'SELECT credentials FROM task_connections WHERE workspace_id = ? AND source = ?',
    )
      .bind(ws, 'jira')
      .first<{ credentials: string }>()
    expect(row?.credentials).toBeTruthy()
    expect(row!.credentials).not.toContain('jira_super_secret_value')
    expect(row!.credentials.startsWith('v1.')).toBe(true)

    await app.call('POST', `/workspaces/${ws}/task-sources/jira/import`, { ref: 'PROJ-2' })
    expect(jira.calls.at(-1)?.credentials.apiToken).toBe('jira_super_secret_value')
  })

  it('disconnecting tombstones the binding', async () => {
    const app = makeApp(new FakeAgentExecutor(), tasksDeps())
    const { workspace } = await app.createWorkspace({ seed: false })
    const ws = workspace.id

    await app.call('POST', `/workspaces/${ws}/task-sources/jira/connect`, {
      credentials: jiraCreds,
    })
    const removed = await app.call('DELETE', `/workspaces/${ws}/task-sources/jira/connection`)
    expect(removed.status).toBe(204)
    const after = await app.call<{ connections: TaskConnection[] }>(
      'GET',
      `/workspaces/${ws}/task-sources/connections`,
    )
    expect(after.body.connections).toEqual([])
  })

  it('returns 503 when the integration is not configured', async () => {
    const app = makeApp(new FakeAgentExecutor())
    const { workspace } = await app.createWorkspace({ seed: false })
    const res = await app.call('GET', `/workspaces/${workspace.id}/task-sources`)
    expect(res.status).toBe(503)
  })
})
