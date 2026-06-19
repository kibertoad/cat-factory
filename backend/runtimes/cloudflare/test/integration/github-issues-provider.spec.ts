import { describe, expect, it } from 'vitest'
import type {
  GitHubInstallation,
  GitHubInstallationRepository,
  GitHubIssueDetail,
} from '@cat-factory/kernel'
import { GitHubIssuesProvider } from '../../src/infrastructure/tasks/GitHubIssuesProvider'
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

/** Minimal installation repo: only `listActive` is exercised by the provider. */
function installationsRepo(active: GitHubInstallation[]): GitHubInstallationRepository {
  return {
    listActive: async () => active,
    getByInstallationId: async () => null,
    getByWorkspace: async () => null,
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
})
