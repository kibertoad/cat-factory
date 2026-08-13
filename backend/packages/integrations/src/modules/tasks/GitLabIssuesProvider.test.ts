import { describe, expect, it } from 'vitest'
import type {
  GitHubClient,
  GitHubInstallation,
  GitHubInstallationRepository,
  GitHubIssueDetail,
  GitHubIssueSearchHit,
  IssueIntakeQuery,
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
  /** Per-page hits, for the intake walk; page 1 is `pages[0]`. Takes precedence over `hits`. */
  pages?: GitHubIssueSearchHit[][]
  issues?: Record<string, GitHubIssueDetail>
  projects?: { owner: string; name: string }[]
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
      return { items: opts.projects ?? [{ owner: 'group/sub', name: 'web' }] }
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
            const page = (query.page ?? 1) - 1
            if (opts.pages) {
              // `hasMore` is what a real GitLab reports, so it tracks whether a NEXT page exists
              // rather than how full this one is. That split is the point of the fixture: a short
              // page with more behind it is exactly the case an instance-lowered `max_page_size`
              // produces, and the case a short-page guess gets wrong.
              return { hits: opts.pages[page] ?? [], hasMore: page + 1 < opts.pages.length }
            }
            return { hits: opts.hits ?? [], hasMore: false }
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

describe('GitLabIssuesProvider.repoScope', () => {
  const provider = new GitLabIssuesProvider({
    gitlabClient: fakeClient({}).client,
    installations: connectionRepo('gitlab'),
  })

  // Declaring `repoScope` is what makes the source repo-backed, and it is read by two callers
  // that never meet: the controller (which resolves a scope BEFORE the search) and the imported-
  // issue list (which filters AFTER). Wiring it to the GitHub matcher would pass every id-shape
  // test in this file and then fold `group/sub/web` onto `group`, so the wiring is pinned here.
  it('is declared, and matches on the GitLab grammar rather than the GitHub one', () => {
    expect(provider.repoScope).toBeDefined()
    expect(provider.repoScope?.matches('group/sub/web#12', scope)).toBe(true)
    expect(provider.repoScope?.matches('group/other/web#12', scope)).toBe(false)
    // The GitHub matcher would fold this to `{ owner: 'group', repo: 'sub' }` and refuse it.
    expect(provider.repoScope?.matches('group/sub/web#12', { owner: 'group', repo: 'sub' })).toBe(
      false,
    )
  })
})

/** A hit as the project-scoped read returns it, carrying the fields a hunt ranks on. */
function hit(number: number, over: Partial<GitHubIssueSearchHit> = {}): GitHubIssueSearchHit {
  return {
    owner: 'group/sub',
    repo: 'web',
    number,
    title: `Issue ${number}`,
    state: 'open',
    url: `https://git.acme.io/group/sub/web/-/issues/${number}`,
    body: 'repro',
    labels: ['bug'],
    createdAt: '2026-01-02T03:04:05Z',
    commentCount: 1,
    ...over,
  }
}

const intake: IssueIntakeQuery = { board: { gitlabProject: 'group/sub/web' }, limit: 1 }

describe('GitLabIssuesProvider.searchIssues', () => {
  it('scopes the schedule’s board as a project argument and returns lean import refs', async () => {
    const { client, searchCalls } = fakeClient({ hits: [hit(5)] })
    const provider = new GitLabIssuesProvider({
      gitlabClient: client,
      installations: connectionRepo('gitlab'),
    })

    const results = await provider.searchIssues({}, intake, 'ws1')

    expect(searchCalls[0]!.ref).toBe('group/sub/web')
    expect(searchCalls[0]!.query).toMatchObject({ openOnly: true, order: 'created-asc' })
    expect(results).toEqual([
      {
        source: 'gitlab',
        externalId: 'group/sub/web#5',
        title: 'Issue 5',
        url: 'https://git.acme.io/group/sub/web/-/issues/5',
        status: 'open',
        excerpt: '',
      },
    ])
  })

  // The already-worked exclusion list is the one predicate this endpoint cannot express, so the
  // request overscans by its size and the excluded ids are dropped from the single response.
  it('overscans by the exclusion count and drops the already-worked ids', async () => {
    const { client, searchCalls } = fakeClient({ hits: [hit(1), hit(2), hit(3)] })
    const provider = new GitLabIssuesProvider({
      gitlabClient: client,
      installations: connectionRepo('gitlab'),
    })

    const results = await provider.searchIssues(
      {},
      { ...intake, excludeExternalIds: ['group/sub/web#1', 'group/sub/web#2'] },
      'ws1',
    )

    expect(searchCalls[0]!.query.limit).toBe(3) // limit 1 + the two excluded ids
    expect(results.map((r) => r.externalId)).toEqual(['group/sub/web#3'])
  })

  // A full page that yields nothing eligible must not read as an exhausted board: the walk pages
  // on until it has its pick or runs out of results.
  it('pages past a full page that yielded nothing eligible', async () => {
    const { client, searchCalls } = fakeClient({
      pages: [[hit(1, { assignee: 'someone' })], [hit(2)]],
    })
    const provider = new GitLabIssuesProvider({
      gitlabClient: client,
      installations: connectionRepo('gitlab'),
    })

    const results = await provider.searchIssues({}, { ...intake, unassignedOnly: true }, 'ws1')

    expect(searchCalls.map((c) => c.query.page)).toEqual([undefined, 2])
    expect(results.map((r) => r.externalId)).toEqual(['group/sub/web#2'])
  })

  it('stops paging when the vendor reports no next page, rather than walking the bound', async () => {
    const { client, searchCalls } = fakeClient({ pages: [[hit(1)]] })
    const provider = new GitLabIssuesProvider({
      gitlabClient: client,
      installations: connectionRepo('gitlab'),
    })

    const results = await provider.searchIssues(
      {},
      { ...intake, limit: 5, excludeExternalIds: ['group/sub/web#1'] },
      'ws1',
    )

    expect(searchCalls).toHaveLength(1)
    expect(results).toEqual([])
  })

  // A page shorter than the overscan asked for proves nothing: `max_page_size` is an instance
  // setting an administrator can lower below it, and on such an instance EVERY page is short. So
  // the walk pages on GitLab's own next-page answer, and a short page with more behind it keeps
  // going instead of reporting a board it never finished as exhausted.
  it('keeps walking a short page the vendor says has more behind it', async () => {
    const { client, searchCalls } = fakeClient({ pages: [[hit(1)], [hit(2)]] })
    const provider = new GitLabIssuesProvider({
      gitlabClient: client,
      installations: connectionRepo('gitlab'),
    })

    const results = await provider.searchIssues(
      {},
      { ...intake, limit: 5, excludeExternalIds: ['group/sub/web#1'] },
      'ws1',
    )

    expect(searchCalls).toHaveLength(2)
    expect(results.map((r) => r.externalId)).toEqual(['group/sub/web#2'])
  })

  // An intake read PICKS WORK TO START, on a schedule nobody is watching, so an empty list is
  // consumed as "no matching open issues" — the opposite fact from "there is no GitLab connection
  // to read one through", and the only one of the two that names something to fix.
  it('refuses when the workspace’s connection is a GitHub App, or absent', async () => {
    for (const provider of ['github', null] as const) {
      const source = new GitLabIssuesProvider({
        gitlabClient: fakeClient({ hits: [hit(5)] }).client,
        installations: connectionRepo(provider),
      })
      await expect(source.searchIssues({}, intake, 'ws1')).rejects.toThrow(/no GitLab connection/i)
    }
  })

  // "This deployment cannot scan a GitLab board" and "this board has no open bugs" are opposite
  // facts, and only the first names something to fix.
  it('refuses when the wired client cannot read project issues, rather than reporting an empty board', async () => {
    const provider = new GitLabIssuesProvider({
      gitlabClient: fakeClient({ omitProjectSearch: true }).client,
      installations: connectionRepo('gitlab'),
    })
    await expect(provider.searchIssues({}, intake, 'ws1')).rejects.toThrow(/cannot search GitLab/i)
  })
})

describe('GitLabIssuesProvider.listBugCandidates', () => {
  it('rates from the SAME response the scan already made, with no per-candidate fetch', async () => {
    const { client, issueCalls } = fakeClient({ hits: [hit(5)] })
    const provider = new GitLabIssuesProvider({
      gitlabClient: client,
      installations: connectionRepo('gitlab'),
    })

    const candidates = await provider.listBugCandidates({}, { ...intake, limit: 40 }, 'ws1')

    expect(issueCalls).toEqual([])
    expect(candidates).toEqual([
      {
        source: 'gitlab',
        externalId: 'group/sub/web#5',
        title: 'Issue 5',
        url: 'https://git.acme.io/group/sub/web/-/issues/5',
        status: 'open',
        type: '',
        priority: null,
        labels: ['bug'],
        description: 'repro',
        createdAt: '2026-01-02T03:04:05Z',
        commentCount: 1,
      },
    ])
  })

  // `assignee_id=None` is what narrows the request; this is the defence against an adapter that
  // reports an assignee while ignoring the parameter, which would offer up in-flight work.
  it('drops an assigned issue even when the vendor ignored the unassigned parameter', async () => {
    const { client, searchCalls } = fakeClient({
      hits: [hit(5, { assignee: 'someone' }), hit(6, { assignee: null })],
    })
    const provider = new GitLabIssuesProvider({
      gitlabClient: client,
      installations: connectionRepo('gitlab'),
    })

    const candidates = await provider.listBugCandidates(
      {},
      { ...intake, limit: 40, unassignedOnly: true },
      'ws1',
    )

    expect(searchCalls[0]!.query.unassignedOnly).toBe(true)
    expect(candidates.map((c) => c.externalId)).toEqual(['group/sub/web#6'])
  })
})
