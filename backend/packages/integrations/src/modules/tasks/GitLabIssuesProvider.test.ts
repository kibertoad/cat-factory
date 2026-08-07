import { describe, expect, it } from 'vitest'
import type {
  GitHubClient,
  GitHubInstallation,
  GitHubInstallationRepository,
  GitHubIssueDetail,
  GitHubIssueSearchHit,
  ProjectIssueQuery,
  VcsProvider,
} from '@cat-factory/kernel'
import { GitLabIssuesProvider } from './GitLabIssuesProvider.js'

/** A connection row as the repository serves it; only the fields the provider reads matter. */
function connectionRepo(provider: VcsProvider | null): GitHubInstallationRepository {
  return {
    async getByWorkspace() {
      if (!provider) return null
      return { installationId: 7, accountLogin: 'ci-bot', provider } as GitHubInstallation
    },
  } as unknown as GitHubInstallationRepository
}

/**
 * A GitLab-backed client recording what each read was SCOPED to, which is the property most of
 * these tests are about: a project-scoped request rather than a query string.
 */
function fakeClient(opts: {
  hits?: GitHubIssueSearchHit[]
  issues?: Record<string, GitHubIssueDetail>
  omitProjectSearch?: boolean
  failWith?: { status?: number; message?: string }
}) {
  const searchCalls: { ref: string; query: ProjectIssueQuery }[] = []
  const issueCalls: string[] = []
  const client = {
    async getIssue(_installationId: number, ref: { owner: string; repo: string }, n: number) {
      issueCalls.push(`${ref.owner}/${ref.repo}#${n}`)
      const found = opts.issues?.[`${ref.owner}/${ref.repo}#${n}`]
      if (!found) throw new Error('not found')
      return found
    },
    async listInstallationRepos() {
      if (opts.failWith)
        throw Object.assign(new Error(opts.failWith.message ?? 'nope'), {
          status: opts.failWith.status,
        })
      return { items: [{ owner: 'group/sub', name: 'web' }] }
    },
    async listIssues() {
      return { items: [] }
    },
    ...(opts.omitProjectSearch
      ? {}
      : {
          async searchProjectIssues(
            _installationId: number,
            ref: { owner: string; repo: string },
            query: ProjectIssueQuery,
          ) {
            searchCalls.push({ ref: `${ref.owner}/${ref.repo}`, query })
            return opts.hits ?? []
          },
        }),
  } as unknown as GitHubClient
  return { client, searchCalls, issueCalls }
}

function detail(over: Partial<GitHubIssueDetail> & { number: number }): GitHubIssueDetail {
  return {
    title: 'Issue',
    state: 'open',
    url: '',
    author: null,
    assignee: null,
    labels: [],
    body: '',
    comments: [],
    ...over,
  }
}

const scope = { owner: 'group/sub', repo: 'web' }

describe('GitLabIssuesProvider.fetchTask', () => {
  it('reads the issue through the workspace connection and keeps the subgroup path', async () => {
    const { client, issueCalls } = fakeClient({
      issues: {
        'group/sub/web#12': detail({
          number: 12,
          title: 'Crash on save',
          url: 'https://git.acme.io/group/sub/web/-/issues/12',
          body: 'boom',
          labels: ['bug'],
          assignee: 'dev',
        }),
      },
    })
    const provider = new GitLabIssuesProvider({
      gitlabClient: client,
      installations: connectionRepo('gitlab'),
    })

    const content = await provider.fetchTask({}, 'group/sub/web#12', 'ws1')

    expect(issueCalls).toEqual(['group/sub/web#12'])
    expect(content).toMatchObject({
      externalId: 'group/sub/web#12',
      title: 'Crash on save',
      url: 'https://git.acme.io/group/sub/web/-/issues/12',
      status: 'open',
      type: 'Issue',
      assignee: 'dev',
      labels: ['bug'],
      description: 'boom',
    })
  })

  // GitLab has no parent→child issue relation, so an import is FLAT by construction rather
  // than by a lookup that failed.
  it('imports flat, with no children and no body-scanned dependency links', async () => {
    const { client } = fakeClient({
      issues: { 'acme/web#1': detail({ number: 1, body: 'Blocked by #99' }) },
    })
    const provider = new GitLabIssuesProvider({
      gitlabClient: client,
      installations: connectionRepo('gitlab'),
    })

    const content = await provider.fetchTask({}, 'acme/web#1', 'ws1')

    expect(content.isEpic).toBe(false)
    expect(content.childExternalIds).toEqual([])
    expect(content.links).toBeUndefined()
  })

  it('rebuilds a missing URL from the deployment web base, and withholds it without one', async () => {
    const issues = { 'acme/web#1': detail({ number: 1, url: '' }) }
    const withBase = new GitLabIssuesProvider({
      gitlabClient: fakeClient({ issues }).client,
      installations: connectionRepo('gitlab'),
      webBaseUrl: 'https://git.acme.io',
    })
    const withoutBase = new GitLabIssuesProvider({
      gitlabClient: fakeClient({ issues }).client,
      installations: connectionRepo('gitlab'),
    })

    expect((await withBase.fetchTask({}, 'acme/web#1', 'ws1')).url).toBe(
      'https://git.acme.io/acme/web/-/issues/1',
    )
    expect((await withoutBase.fetchTask({}, 'acme/web#1', 'ws1')).url).toBe('')
  })

  // "Connected to a VCS" and "connected to GitLab" are different facts: one row per workspace.
  it('refuses a workspace whose connection is a GitHub App, and one with none', async () => {
    const { client } = fakeClient({})
    const onGitHub = new GitLabIssuesProvider({
      gitlabClient: client,
      installations: connectionRepo('github'),
    })
    const unconnected = new GitLabIssuesProvider({
      gitlabClient: client,
      installations: connectionRepo(null),
    })

    await expect(onGitHub.fetchTask({}, 'acme/web#1', 'ws1')).rejects.toThrow(/GitLab connection/i)
    await expect(unconnected.fetchTask({}, 'acme/web#1', 'ws1')).rejects.toThrow(
      /GitLab connection/i,
    )
  })

  it('refuses a malformed reference', async () => {
    const provider = new GitLabIssuesProvider({
      gitlabClient: fakeClient({}).client,
      installations: connectionRepo('gitlab'),
    })
    await expect(provider.fetchTask({}, 'not-a-ref', 'ws1')).rejects.toThrow(/not a valid GitLab/i)
  })
})

describe('GitLabIssuesProvider.search', () => {
  it('scopes the read to the searching frame’s project, as an argument not a qualifier', async () => {
    const { client, searchCalls } = fakeClient({
      hits: [
        {
          owner: 'group/sub',
          repo: 'web',
          number: 5,
          title: 'Crash',
          state: 'open',
          url: 'https://git.acme.io/group/sub/web/-/issues/5',
        },
      ],
    })
    const provider = new GitLabIssuesProvider({
      gitlabClient: client,
      installations: connectionRepo('gitlab'),
    })

    const results = await provider.search({}, 'crash', 'ws1', scope)

    expect(searchCalls).toEqual([{ ref: 'group/sub/web', query: { limit: 20, text: 'crash' } }])
    expect(results).toEqual([
      {
        source: 'gitlab',
        externalId: 'group/sub/web#5',
        title: 'Crash',
        url: 'https://git.acme.io/group/sub/web/-/issues/5',
        status: 'open',
        excerpt: '',
      },
    ])
  })

  // An unscoped GitLab issue search cannot be narrowed after the fact: it returns every issue
  // the PAT can read across the instance.
  it('refuses an unscoped search rather than widening it', async () => {
    const provider = new GitLabIssuesProvider({
      gitlabClient: fakeClient({}).client,
      installations: connectionRepo('gitlab'),
    })
    await expect(provider.search({}, 'crash', 'ws1', null)).rejects.toThrow(/scoped to a project/i)
  })

  it('surfaces an exact reference first and does not duplicate it among the hits', async () => {
    const hit = {
      owner: 'group/sub',
      repo: 'web',
      number: 42,
      title: 'From search',
      state: 'open',
      url: 'u',
    }
    const { client } = fakeClient({
      hits: [hit],
      issues: {
        'group/sub/web#42': detail({ number: 42, title: 'Exact', url: 'https://x/42' }),
      },
    })
    const provider = new GitLabIssuesProvider({
      gitlabClient: client,
      installations: connectionRepo('gitlab'),
    })

    const results = await provider.search({}, '42', 'ws1', scope)

    expect(results.map((r) => r.title)).toEqual(['Exact'])
    expect(results[0]!.externalId).toBe('group/sub/web#42')
  })

  it('falls through to the text search when the exact lookup misses', async () => {
    const { client } = fakeClient({ hits: [] })
    const provider = new GitLabIssuesProvider({
      gitlabClient: client,
      installations: connectionRepo('gitlab'),
    })
    await expect(provider.search({}, '999', 'ws1', scope)).resolves.toEqual([])
  })

  it('returns nothing when the workspace has no GitLab connection', async () => {
    const provider = new GitLabIssuesProvider({
      gitlabClient: fakeClient({}).client,
      installations: connectionRepo('github'),
    })
    await expect(provider.search({}, 'crash', 'ws1', scope)).resolves.toEqual([])
  })
})

describe('GitLabIssuesProvider.diagnose', () => {
  it('reports ready with the reachable project count', async () => {
    const provider = new GitLabIssuesProvider({
      gitlabClient: fakeClient({}).client,
      installations: connectionRepo('gitlab'),
    })
    const result = await provider.diagnose({ workspaceId: 'ws1', credentials: null })
    expect(result).toMatchObject({ source: 'gitlab', ok: true, status: 'ready' })
    expect(result.detail).toMatch(/1 project accessible/)
  })

  it('names the missing connection rather than a generic failure', async () => {
    const provider = new GitLabIssuesProvider({
      gitlabClient: fakeClient({}).client,
      installations: connectionRepo(null),
    })
    await expect(
      provider.diagnose({ workspaceId: 'ws1', credentials: null }),
    ).resolves.toMatchObject({ ok: false, status: 'not_installed' })
  })

  // The four causes need four different fixes, so each classifies rather than rejecting.
  it.each([
    [401, 'auth_failed', /revoked or has expired/i],
    [403, 'forbidden', /scope/i],
    [undefined, 'unreachable', /API base URL/i],
    [500, 'error', /500/],
  ])('classifies a %s failure as %s', async (status, expected, message) => {
    const provider = new GitLabIssuesProvider({
      gitlabClient: fakeClient({ failWith: { status } }).client,
      installations: connectionRepo('gitlab'),
    })
    const result = await provider.diagnose({ workspaceId: 'ws1', credentials: null })
    expect(result.status).toBe(expected)
    expect(result.message).toMatch(message)
  })
})
