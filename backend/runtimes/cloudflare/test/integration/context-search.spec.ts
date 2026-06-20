import type { DocumentSearchResult, TaskSearchResult } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { documentsDeps, makeApp, tasksDeps } from '../helpers'
import { FakeAgentExecutor } from '../fakes/FakeAgentExecutor'
import { FakeDocumentSourceProvider } from '../fakes/FakeDocumentSourceProvider'
import { FakeTaskSourceProvider } from '../fakes/FakeTaskSourceProvider'

// The search endpoints back the add-task popup's "search a connected source"
// surface: a connected source's catalogue is queried by free text, returning lean
// hits the UI imports + links on selection. Here we drive them through the worker
// + real D1 with a fake provider holding canned hits, asserting the wiring (auth
// with the stored credentials, the {results} envelope) and the unconnected guard.

describe('document source search', () => {
  it('searches a connected source with its stored credentials', async () => {
    const confluence = new FakeDocumentSourceProvider('confluence')
    confluence.searchResults = [
      {
        source: 'confluence',
        externalId: '777',
        title: 'Rate limiting RFC',
        url: 'https://acme.atlassian.net/wiki/pages/777',
        excerpt: '',
      },
    ]
    const app = makeApp(new FakeAgentExecutor(), documentsDeps({ providers: [confluence] }))
    const { workspace } = await app.createWorkspace({ seed: false })

    await app.call('POST', `/workspaces/${workspace.id}/document-sources/confluence/connect`, {
      credentials: { baseUrl: 'https://acme.atlassian.net', accountEmail: 'd@a.io', apiToken: 's' },
    })

    const res = await app.call<{ results: DocumentSearchResult[] }>(
      'POST',
      `/workspaces/${workspace.id}/document-sources/confluence/search`,
      { query: 'rate limit' },
    )
    expect(res.status).toBe(200)
    expect(res.body.results).toEqual(confluence.searchResults)
    // The provider authenticated with the connection's stored credentials.
    expect(confluence.searchCalls).toEqual([
      {
        credentials: {
          baseUrl: 'https://acme.atlassian.net',
          accountEmail: 'd@a.io',
          apiToken: 's',
        },
        query: 'rate limit',
      },
    ])
  })

  it('rejects a search against an unconnected source', async () => {
    const app = makeApp(new FakeAgentExecutor(), documentsDeps())
    const { workspace } = await app.createWorkspace({ seed: false })

    const res = await app.call(
      'POST',
      `/workspaces/${workspace.id}/document-sources/confluence/search`,
      { query: 'anything' },
    )
    expect(res.status).toBe(409)
  })
})

describe('task source search', () => {
  it('searches a connected tracker with its stored credentials', async () => {
    const jira = new FakeTaskSourceProvider('jira')
    jira.searchResults = [
      {
        source: 'jira',
        externalId: 'PROJ-9',
        title: 'Login bug',
        url: 'https://acme.atlassian.net/browse/PROJ-9',
        status: 'In Progress',
        excerpt: '',
      },
    ]
    const app = makeApp(new FakeAgentExecutor(), tasksDeps({ providers: [jira] }))
    const { workspace } = await app.createWorkspace({ seed: false })

    await app.call('POST', `/workspaces/${workspace.id}/task-sources/jira/connect`, {
      credentials: { baseUrl: 'https://acme.atlassian.net', accountEmail: 'd@a.io', apiToken: 's' },
    })

    const res = await app.call<{ results: TaskSearchResult[] }>(
      'POST',
      `/workspaces/${workspace.id}/task-sources/jira/search`,
      { query: 'login' },
    )
    expect(res.status).toBe(200)
    expect(res.body.results).toEqual(jira.searchResults)
    expect(jira.searchCalls.map((c) => c.query)).toEqual(['login'])
  })
})
