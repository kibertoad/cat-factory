import { describe, expect, it } from 'vitest'
import type {
  GitHubInstallation,
  GitHubInstallationRepository,
  GitHubIssueDetail,
} from '@cat-factory/kernel'
import { GitHubIssuesProvider } from '@cat-factory/integrations'
import { FakeGitHubClient } from '../fakes/FakeGitHubClient'

// Pure unit test for the GitHub-issues task-source provider: it resolves the
// installation that owns the issue's repo (by account login), reads the issue via
// the GitHubClient, and maps it onto the structured TaskContent. No D1 / network.

function installation(overrides: Partial<GitHubInstallation>): GitHubInstallation {
  return {
    installationId: 100,
    workspaceId: 'ws_1',
    accountId: null,
    accountLogin: 'octo',
    targetType: 'Organization',
    appId: 'app-default',
    cachedToken: null,
    tokenExpiresAt: null,
    createdAt: 0,
    deletedAt: null,
    ...overrides,
  }
}

/**
 * Minimal installation repo: `listActive` backs `fetchTask`'s owner resolution;
 * `getByWorkspace` backs the workspace-scoped `search`.
 */
function installationsRepo(active: GitHubInstallation[]): GitHubInstallationRepository {
  return {
    listActive: async () => active,
    getByInstallationId: async () => null,
    listByInstallationIds: async () => [],
    getByWorkspace: async (workspaceId) =>
      active.find((i) => i.workspaceId === workspaceId) ?? null,
    listWorkspacesForInstallation: async () => [],
    upsert: async () => {},
    updateCachedToken: async () => {},
    softDelete: async () => {},
  }
}

function providerWith(detail: GitHubIssueDetail, active = [installation({})]) {
  const client = new FakeGitHubClient()
  client.issueDetails[`${'octo'}/${'app'}#${detail.number}`] = detail
  const provider = new GitHubIssuesProvider({
    githubClient: client,
    installations: installationsRepo(active),
  })
  return { provider, client }
}

const DETAIL: GitHubIssueDetail = {
  number: 7,
  title: 'Add CSV export',
  state: 'open',
  url: 'https://github.com/octo/app/issues/7',
  author: 'ada',
  assignee: 'bob',
  labels: ['enhancement'],
  body: 'Customers want CSV.',
  comments: [{ author: 'cid', createdAt: '2026-01-02T00:00:00Z', body: 'UTF-8 please' }],
}

describe('GitHubIssuesProvider', () => {
  it('parses refs via the shared logic', () => {
    const { provider } = providerWith(DETAIL)
    expect(provider.parseRef('https://github.com/octo/app/issues/7')).toBe('octo/app#7')
    expect(provider.parseRef('nope')).toBeNull()
  })

  it('stores no credentials (reuses the installed App)', () => {
    const { provider } = providerWith(DETAIL)
    expect(provider.normalizeConnection({})).toEqual({ credentials: {}, label: 'GitHub' })
  })

  it('fetches an issue and maps it to structured TaskContent', async () => {
    const { provider } = providerWith(DETAIL)
    const content = await provider.fetchTask({}, 'octo/app#7')
    expect(content).toMatchObject({
      externalId: 'octo/app#7',
      url: 'https://github.com/octo/app/issues/7',
      title: 'Add CSV export',
      status: 'open',
      type: 'Issue',
      assignee: 'bob',
      priority: null,
      labels: ['enhancement'],
      description: 'Customers want CSV.',
    })
    expect(content.comments).toEqual([
      { author: 'cid', createdAt: '2026-01-02T00:00:00Z', body: 'UTF-8 please' },
    ])
  })

  it('rejects a malformed external id', async () => {
    const { provider } = providerWith(DETAIL)
    await expect(provider.fetchTask({}, 'not-a-ref')).rejects.toThrow()
  })

  it('errors clearly when no installation owns the repo', async () => {
    const { provider } = providerWith(DETAIL, [installation({ accountLogin: 'other' })])
    await expect(provider.fetchTask({}, 'octo/app#7')).rejects.toThrow(/installation/i)
  })

  it('scopes search to the workspace own installation, not every installation', async () => {
    const { provider, client } = providerWith(DETAIL, [
      installation({ workspaceId: 'ws_1', installationId: 100 }),
      installation({ workspaceId: 'ws_2', installationId: 200, accountLogin: 'other' }),
    ])
    client.issueSearchHits = [
      {
        owner: 'octo',
        repo: 'app',
        number: 7,
        title: 'Add CSV export',
        state: 'open',
        url: 'https://github.com/octo/app/issues/7',
      },
    ]
    const results = await provider.search({}, 'csv', 'ws_1')
    expect(results).toEqual([
      {
        source: 'github',
        externalId: 'octo/app#7',
        title: 'Add CSV export',
        url: 'https://github.com/octo/app/issues/7',
        status: 'open',
        excerpt: '',
      },
    ])
    // Only ws_1's installation (100) was queried — never ws_2's (200).
    expect(client.searchIssuesCalls).toEqual([{ installationId: 100, query: 'csv' }])
  })

  it('returns no results when the workspace has no installation', async () => {
    const { provider, client } = providerWith(DETAIL, [
      installation({ workspaceId: 'ws_1', installationId: 100 }),
    ])
    client.issueSearchHits = [
      {
        owner: 'octo',
        repo: 'app',
        number: 7,
        title: 'x',
        state: 'open',
        url: 'https://github.com/octo/app/issues/7',
      },
    ]
    expect(await provider.search({}, 'csv', 'ws_unknown')).toEqual([])
    expect(client.searchIssuesCalls).toEqual([])
  })
})
