import type { SourceDocument } from '@cat-factory/core'
import { describe, expect, it } from 'vitest'
import { documentsDeps, makeApp } from '../helpers'
import { FakeAgentExecutor } from '../fakes/FakeAgentExecutor'
import { FakeDocumentSourceProvider } from '../fakes/FakeDocumentSourceProvider'

const confluenceCreds = {
  baseUrl: 'https://acme.atlassian.net',
  accountEmail: 'dev@acme.io',
  apiToken: 'secret-token',
}

async function connected(providers?: FakeDocumentSourceProvider[]) {
  const app = makeApp(new FakeAgentExecutor(), documentsDeps({ providers }))
  const { workspace } = await app.createWorkspace({ seed: false })
  await app.call('POST', `/workspaces/${workspace.id}/document-sources/confluence/connect`, {
    credentials: confluenceCreds,
  })
  return { app, workspaceId: workspace.id }
}

describe('document import', () => {
  it('imports a page and lists it, authenticating with the stored credentials', async () => {
    const confluence = new FakeDocumentSourceProvider('confluence', {
      '12345': { title: 'Auth PRD', body: '# Auth PRD\nRequirements here' },
    })
    const { app, workspaceId } = await connected([confluence])

    const imported = await app.call<SourceDocument>(
      'POST',
      `/workspaces/${workspaceId}/document-sources/confluence/import`,
      { ref: '12345' },
    )
    expect(imported.status).toBe(201)
    expect(imported.body.source).toBe('confluence')
    expect(imported.body.externalId).toBe('12345')
    expect(imported.body.title).toBe('Auth PRD')
    expect(imported.body.excerpt).toContain('Requirements here')
    expect(confluence.calls[0]?.credentials.apiToken).toBe('secret-token')

    const list = await app.call<SourceDocument[]>('GET', `/workspaces/${workspaceId}/documents`)
    expect(list.body).toHaveLength(1)
    expect(list.body[0]?.externalId).toBe('12345')
  })

  it('lists documents across sources', async () => {
    const confluence = new FakeDocumentSourceProvider('confluence', { '1': { title: 'C doc' } })
    const notion = new FakeDocumentSourceProvider('notion', { '2': { title: 'N doc' } })
    const app = makeApp(new FakeAgentExecutor(), documentsDeps({ providers: [confluence, notion] }))
    const { workspace } = await app.createWorkspace({ seed: false })
    const ws = workspace.id

    await app.call('POST', `/workspaces/${ws}/document-sources/confluence/connect`, {
      credentials: confluenceCreds,
    })
    await app.call('POST', `/workspaces/${ws}/document-sources/notion/connect`, {
      credentials: { apiToken: 'ntn_secret' },
    })
    await app.call('POST', `/workspaces/${ws}/document-sources/confluence/import`, { ref: '1' })
    await app.call('POST', `/workspaces/${ws}/document-sources/notion/import`, { ref: '2' })

    const list = await app.call<SourceDocument[]>('GET', `/workspaces/${ws}/documents`)
    expect(list.body.map((d) => d.source).sort()).toEqual(['confluence', 'notion'])
  })

  it('rejects an import when the input is blank (fails contract validation)', async () => {
    const { app, workspaceId } = await connected()
    const res = await app.call(
      'POST',
      `/workspaces/${workspaceId}/document-sources/confluence/import`,
      { ref: '   ' },
    )
    expect(res.status).toBe(400)
  })

  it('rejects an import when the workspace is not connected', async () => {
    const app = makeApp(new FakeAgentExecutor(), documentsDeps())
    const { workspace } = await app.createWorkspace({ seed: false })
    const res = await app.call(
      'POST',
      `/workspaces/${workspace.id}/document-sources/confluence/import`,
      {
        ref: '12345',
      },
    )
    expect(res.status).toBe(409)
  })
})
