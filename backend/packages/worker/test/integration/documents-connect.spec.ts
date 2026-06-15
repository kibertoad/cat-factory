import type { DocumentConnection, DocumentSourceDescriptor } from '@cat-factory/core'
import { describe, expect, it } from 'vitest'
import { documentsDeps, makeApp } from '../helpers'
import { FakeAgentExecutor } from '../fakes/FakeAgentExecutor'

const confluenceCreds = {
  baseUrl: 'https://acme.atlassian.net',
  accountEmail: 'dev@acme.io',
  apiToken: 'secret-token',
}

describe('document source connect', () => {
  it('lists the configured sources with their connect metadata', async () => {
    const app = makeApp(new FakeAgentExecutor(), documentsDeps())
    const { workspace } = await app.createWorkspace({ seed: false })

    const res = await app.call<{ sources: DocumentSourceDescriptor[] }>(
      'GET',
      `/workspaces/${workspace.id}/document-sources`,
    )
    expect(res.status).toBe(200)
    expect(res.body.sources.map((s) => s.source).sort()).toEqual(['confluence', 'notion'])
    const confluence = res.body.sources.find((s) => s.source === 'confluence')!
    expect(confluence.credentialFields.map((f) => f.key)).toContain('apiToken')
  })

  it('connects a source and reads it back without leaking credentials', async () => {
    const app = makeApp(new FakeAgentExecutor(), documentsDeps())
    const { workspace } = await app.createWorkspace({ seed: false })

    const connected = await app.call<DocumentConnection>(
      'POST',
      `/workspaces/${workspace.id}/document-sources/confluence/connect`,
      { credentials: confluenceCreds },
    )
    expect(connected.status).toBe(201)
    expect(connected.body.source).toBe('confluence')
    expect((connected.body as Record<string, unknown>).credentials).toBeUndefined()
    expect((connected.body as Record<string, unknown>).apiToken).toBeUndefined()

    const read = await app.call<{ connections: DocumentConnection[] }>(
      'GET',
      `/workspaces/${workspace.id}/document-sources/connections`,
    )
    expect(read.body.connections.map((c) => c.source)).toEqual(['confluence'])
  })

  it('holds independent connections per source', async () => {
    const app = makeApp(new FakeAgentExecutor(), documentsDeps())
    const { workspace } = await app.createWorkspace({ seed: false })
    const ws = workspace.id

    await app.call('POST', `/workspaces/${ws}/document-sources/confluence/connect`, {
      credentials: confluenceCreds,
    })
    await app.call('POST', `/workspaces/${ws}/document-sources/notion/connect`, {
      credentials: { apiToken: 'ntn_secret' },
    })

    const read = await app.call<{ connections: DocumentConnection[] }>(
      'GET',
      `/workspaces/${ws}/document-sources/connections`,
    )
    expect(read.body.connections.map((c) => c.source).sort()).toEqual(['confluence', 'notion'])

    // Disconnecting one leaves the other intact.
    const removed = await app.call('DELETE', `/workspaces/${ws}/document-sources/notion/connection`)
    expect(removed.status).toBe(204)
    const after = await app.call<{ connections: DocumentConnection[] }>(
      'GET',
      `/workspaces/${ws}/document-sources/connections`,
    )
    expect(after.body.connections.map((c) => c.source)).toEqual(['confluence'])
  })

  it('rejects an unknown source', async () => {
    const app = makeApp(new FakeAgentExecutor(), documentsDeps())
    const { workspace } = await app.createWorkspace({ seed: false })
    const res = await app.call(
      'POST',
      `/workspaces/${workspace.id}/document-sources/jira/connect`,
      {
        credentials: { apiToken: 'x' },
      },
    )
    expect(res.status).toBe(422)
  })

  it('returns 503 when the integration is not configured', async () => {
    const app = makeApp(new FakeAgentExecutor())
    const { workspace } = await app.createWorkspace({ seed: false })
    const res = await app.call('GET', `/workspaces/${workspace.id}/document-sources`)
    expect(res.status).toBe(503)
  })
})
