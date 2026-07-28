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
  // Every issue search names the block it runs from: for a repo-backed source that block is
  // what confines the search to one repository, and the endpoint takes the same shape for a
  // repo-less source (Jira has nothing to narrow, so it simply ignores it).
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
    const { workspace, blocks } = await app.createWorkspace()

    await app.call('POST', `/workspaces/${workspace.id}/task-sources/jira/connect`, {
      credentials: { baseUrl: 'https://acme.atlassian.net', accountEmail: 'd@a.io', apiToken: 's' },
    })

    const res = await app.call<{ results: TaskSearchResult[] }>(
      'POST',
      `/workspaces/${workspace.id}/task-sources/jira/search`,
      { query: 'login', blockId: blocks[0]!.id },
    )
    expect(res.status).toBe(200)
    expect(res.body.results).toEqual(jira.searchResults)
    expect(jira.searchCalls.map((c) => c.query)).toEqual(['login'])
  })

  it('refuses a search that names no block, so nothing can run unscoped', async () => {
    // The block is the scope. Accepting a search without one is how a GitHub query ended up
    // with no `repo:` qualifier — which under an App token quietly meant "the installation's
    // repos" but under a PAT means every public repository on GitHub.
    const jira = new FakeTaskSourceProvider('jira')
    const app = makeApp(new FakeAgentExecutor(), tasksDeps({ providers: [jira] }))
    const { workspace } = await app.createWorkspace({ seed: false })

    await app.call('POST', `/workspaces/${workspace.id}/task-sources/jira/connect`, {
      credentials: { baseUrl: 'https://acme.atlassian.net', accountEmail: 'd@a.io', apiToken: 's' },
    })

    const res = await app.call('POST', `/workspaces/${workspace.id}/task-sources/jira/search`, {
      query: 'login',
    })

    expect(res.status).toBe(400)
    expect(jira.searchCalls).toEqual([])
  })

  it('refuses a repo-backed search from a service with no linked repository', async () => {
    // The other half of the guard: the block IS named, but it resolves to no repo — so there
    // is nothing to scope to and the search is refused rather than widened. The `reason` is
    // the contract with the SPA (it renders localized "link a repo first" copy off this code,
    // not off the prose), so it is asserted here rather than just the status.
    const github = new FakeTaskSourceProvider('github')
    const app = makeApp(new FakeAgentExecutor(), tasksDeps({ providers: [github] }))
    const { workspace, blocks } = await app.createWorkspace()

    await app.call('POST', `/workspaces/${workspace.id}/task-sources/github/connect`, {
      credentials: {},
    })

    const res = await app.call<{ error: { details?: { reason?: string } } }>(
      'POST',
      `/workspaces/${workspace.id}/task-sources/github/search`,
      { query: 'login', blockId: blocks[0]!.id },
    )

    // 422, not the 400 the missing-`blockId` case above returns: that one is refused by the
    // wire contract before the handler runs, this one is a domain `ValidationError` raised
    // inside it. Both are refusals; only the second carries a reason the SPA can act on.
    expect(res.status).toBe(422)
    expect(res.body.error.details?.reason).toBe('repo_not_linked')
    // Refused BEFORE the provider is reached — the point is that no query is ever issued.
    expect(github.searchCalls).toEqual([])
  })
})
