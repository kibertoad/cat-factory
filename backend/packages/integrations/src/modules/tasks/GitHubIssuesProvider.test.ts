import { describe, expect, it } from 'vitest'
import type {
  GitHubClient,
  GitHubInstallationRepository,
  GitHubIssueDetail,
  GitHubIssueSearchHit,
} from '@cat-factory/kernel'
import { GitHubIssuesProvider } from './GitHubIssuesProvider.js'

// A minimal GitHub client recording the search query it was handed and serving
// canned issue details by `owner/repo#number`. Only the methods the provider's
// search path touches are implemented; the rest throw if ever called.
function fakeClient(opts: {
  hits?: GitHubIssueSearchHit[]
  issues?: Record<string, GitHubIssueDetail>
}) {
  const searchCalls: string[] = []
  const issueCalls: string[] = []
  const client = {
    async searchIssues(_installationId: number, query: string) {
      searchCalls.push(query)
      return opts.hits ?? []
    },
    async getIssue(_installationId: number, ref: { owner: string; repo: string }, n: number) {
      issueCalls.push(`${ref.owner}/${ref.repo}#${n}`)
      const found = opts.issues?.[`${ref.owner}/${ref.repo}#${n}`]
      if (!found) throw new Error('not found')
      return found
    },
  } as unknown as GitHubClient
  return { client, searchCalls, issueCalls }
}

const installations = {
  async getByWorkspace() {
    return { installationId: 1, accountLogin: 'kibertoad' }
  },
  async listActive() {
    return [{ installationId: 1, accountLogin: 'kibertoad' }]
  },
} as unknown as GitHubInstallationRepository

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

const scope = { owner: 'kibertoad', repo: 'simple-service' }

describe('GitHubIssuesProvider.search', () => {
  it('scopes the text search to the service repo', async () => {
    const { client, searchCalls } = fakeClient({
      hits: [
        {
          owner: 'kibertoad',
          repo: 'simple-service',
          number: 5,
          title: 'A',
          state: 'open',
          url: 'u5',
        },
      ],
    })
    const provider = new GitHubIssuesProvider({ githubClient: client, installations })

    const results = await provider.search({}, 'login bug', 'ws1', scope)

    expect(searchCalls).toEqual(['repo:kibertoad/simple-service login bug'])
    expect(results).toEqual([
      {
        source: 'github',
        externalId: 'kibertoad/simple-service#5',
        title: 'A',
        url: 'u5',
        status: 'open',
        excerpt: '',
      },
    ])
  })

  it('resolves a bare issue number against the scoped repo and surfaces it first', async () => {
    const { client } = fakeClient({
      issues: {
        'kibertoad/simple-service#11': detail({
          number: 11,
          title: 'Eleven',
          url: 'https://github.com/kibertoad/simple-service/issues/11',
        }),
      },
    })
    const provider = new GitHubIssuesProvider({ githubClient: client, installations })

    const results = await provider.search({}, '11', 'ws1', scope)

    expect(results[0]).toEqual({
      source: 'github',
      externalId: 'kibertoad/simple-service#11',
      title: 'Eleven',
      url: 'https://github.com/kibertoad/simple-service/issues/11',
      status: 'open',
      excerpt: '',
    })
  })

  it('resolves a pasted issue URL to the exact issue', async () => {
    const { client } = fakeClient({
      issues: {
        'kibertoad/simple-service#11': detail({ number: 11, title: 'Eleven', url: 'u11' }),
      },
    })
    const provider = new GitHubIssuesProvider({ githubClient: client, installations })

    const results = await provider.search(
      {},
      'https://github.com/kibertoad/simple-service/issues/11',
      'ws1',
      scope,
    )

    expect(results.map((r) => r.externalId)).toContain('kibertoad/simple-service#11')
  })

  it('falls through to text search when the exact lookup misses', async () => {
    const { client } = fakeClient({ hits: [], issues: {} })
    const provider = new GitHubIssuesProvider({ githubClient: client, installations })

    // #999 does not exist → getIssue throws → no exact hit, search still runs cleanly.
    await expect(provider.search({}, '999', 'ws1', scope)).resolves.toEqual([])
  })

  it('never reaches across tenants: a pasted URL to another account is not fetched', async () => {
    // The workspace's installation is on `kibertoad`; a URL naming a DIFFERENT account
    // must NOT be resolved against that account's issues (cross-tenant leak). The exact
    // lookup is skipped (getIssue is never called) and it falls through to the
    // repo-scoped text search, which finds nothing.
    const { client, issueCalls } = fakeClient({ hits: [] })
    const provider = new GitHubIssuesProvider({ githubClient: client, installations })

    const results = await provider.search(
      {},
      'https://github.com/other-org/secret/issues/3',
      'ws1',
      scope,
    )

    expect(issueCalls).toEqual([])
    expect(results).toEqual([])
  })
})
