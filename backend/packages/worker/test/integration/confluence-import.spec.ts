import type { ConfluenceDocument } from '@cat-factory/core'
import { describe, expect, it } from 'vitest'
import { confluenceDeps, makeApp } from '../helpers'
import { FakeAgentExecutor } from '../fakes/FakeAgentExecutor'
import { FakeConfluenceClient } from '../fakes/FakeConfluenceClient'

const creds = {
  baseUrl: 'https://acme.atlassian.net',
  accountEmail: 'dev@acme.io',
  apiToken: 'secret-token',
}

async function connected(client?: FakeConfluenceClient) {
  const app = makeApp(new FakeAgentExecutor(), confluenceDeps({ client }))
  const { workspace } = await app.createWorkspace({ seed: false })
  await app.call('POST', `/workspaces/${workspace.id}/confluence/connect`, creds)
  return { app, workspaceId: workspace.id }
}

describe('confluence import', () => {
  it('imports a page and lists it, authenticating with the stored token', async () => {
    const client = new FakeConfluenceClient({
      '12345': { title: 'Auth PRD', spaceKey: 'PROD', body: '<p>Requirements here</p>' },
    })
    const { app, workspaceId } = await connected(client)

    const imported = await app.call<ConfluenceDocument>(
      'POST',
      `/workspaces/${workspaceId}/confluence/import`,
      { page: '12345' },
    )
    expect(imported.status).toBe(201)
    expect(imported.body.pageId).toBe('12345')
    expect(imported.body.title).toBe('Auth PRD')
    expect(imported.body.excerpt).toContain('Requirements here')
    expect(client.calls[0]?.creds.apiToken).toBe('secret-token')

    const list = await app.call<ConfluenceDocument[]>(
      'GET',
      `/workspaces/${workspaceId}/confluence/documents`,
    )
    expect(list.body).toHaveLength(1)
    expect(list.body[0]?.pageId).toBe('12345')
  })

  it('resolves a page id from a full Confluence URL', async () => {
    const { app, workspaceId } = await connected()
    const imported = await app.call<ConfluenceDocument>(
      'POST',
      `/workspaces/${workspaceId}/confluence/import`,
      { page: 'https://acme.atlassian.net/wiki/spaces/ENG/pages/98765/Some+Title' },
    )
    expect(imported.status).toBe(201)
    expect(imported.body.pageId).toBe('98765')
  })

  it('rejects an import when the input has no resolvable page id', async () => {
    const { app, workspaceId } = await connected()
    const res = await app.call('POST', `/workspaces/${workspaceId}/confluence/import`, {
      page: 'not-a-page',
    })
    expect(res.status).toBe(422)
  })

  it('rejects an import when the workspace is not connected', async () => {
    const app = makeApp(new FakeAgentExecutor(), confluenceDeps())
    const { workspace } = await app.createWorkspace({ seed: false })
    const res = await app.call('POST', `/workspaces/${workspace.id}/confluence/import`, {
      page: '12345',
    })
    expect(res.status).toBe(409)
  })
})
