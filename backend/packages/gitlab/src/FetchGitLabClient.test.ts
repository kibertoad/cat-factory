import { describe, expect, it } from 'vitest'
import type { VcsConnectionRef, VcsRepoRef } from '@cat-factory/kernel'
import { clearVcsProviders, resolveVcsProvider } from '@cat-factory/kernel'
import { FetchGitLabClient } from './FetchGitLabClient.js'
import { StaticGitLabTokenSource } from './tokenSource.js'
import { registerGitLab } from './index.js'
import { GitLabWebhookMapper, GitLabWebhookVerifier } from './webhook.js'

// A scripted fetch: matches each request by `METHOD path` (path = URL minus the api base)
// and returns the queued response. Asserts the PRIVATE-TOKEN header is always sent.
function fakeFetch(
  routes: Record<string, { status?: number; body?: unknown; headers?: Record<string, string> }>,
): { fetchImpl: typeof fetch; calls: { method: string; url: string; body?: unknown }[] } {
  const calls: { method: string; url: string; body?: unknown }[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString()
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = (init?.headers ?? {}) as Record<string, string>
    expect(headers['private-token']).toBe('tok')
    const path = u.replace('https://gitlab.com/api/v4', '')
    calls.push({
      method,
      url: path,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    })
    const key = `${method} ${path}`
    const route = routes[key]
    if (!route) throw new Error(`Unexpected request: ${key}`)
    const status = route.status ?? 200
    return new Response(route.body === undefined ? null : JSON.stringify(route.body), {
      status,
      headers: { 'content-type': 'application/json', ...route.headers },
    })
  }) as unknown as typeof fetch

  return { fetchImpl, calls }
}

const connection: VcsConnectionRef = { provider: 'gitlab', connectionId: '42' }
const ref: VcsRepoRef = { repoId: '7', owner: 'group', repo: 'proj' }
const clock = { now: () => 1_000 }

function client(routes: Parameters<typeof fakeFetch>[0]) {
  const { fetchImpl, calls } = fakeFetch(routes)
  const c = new FetchGitLabClient({
    tokenSource: new StaticGitLabTokenSource('tok'),
    clock,
    fetchImpl,
  })
  return { c, calls }
}

describe('FetchGitLabClient', () => {
  it('maps a project to the neutral repo projection', async () => {
    const { c } = client({
      'GET /projects/7': {
        body: {
          id: 7,
          path: 'proj',
          path_with_namespace: 'group/proj',
          default_branch: 'main',
          visibility: 'private',
        },
      },
    })
    const repo = await c.getRepo(connection, ref)
    expect(repo).toMatchObject({
      githubId: 7,
      installationId: 42,
      owner: 'group',
      name: 'proj',
      defaultBranch: 'main',
      private: true,
      syncedAt: 1_000,
    })
  })

  it('maps merge requests to neutral pull requests (open/merged/closed)', async () => {
    const { c } = client({
      'GET /projects/7/merge_requests?state=all&order_by=updated_at&sort=desc&per_page=100': {
        body: [
          {
            id: 100,
            iid: 3,
            title: 'Add feature',
            state: 'opened',
            source_branch: 'feat',
            target_branch: 'main',
            sha: 'abc',
            author: { username: 'alice' },
            updated_at: '2024-01-01T00:00:00Z',
          },
          { id: 101, iid: 4, title: 'Done', state: 'merged', sha: 'def' },
        ],
      },
    })
    const { items } = await c.listPullRequests(connection, ref)
    expect(items[0]).toMatchObject({
      number: 3,
      githubId: 100,
      state: 'open',
      merged: false,
      headRef: 'feat',
      baseRef: 'main',
      headSha: 'abc',
      author: 'alice',
    })
    expect(items[1]).toMatchObject({ number: 4, state: 'closed', merged: true })
  })

  it('maps commit statuses to neutral check runs (success/failed/pending)', async () => {
    const { c } = client({
      'GET /projects/7/repository/commits/abc/statuses?per_page=100': {
        body: [
          { id: 1, sha: 'abc', name: 'build', status: 'success' },
          { id: 2, sha: 'abc', name: 'test', status: 'failed', target_url: 'http://ci/2' },
          { id: 3, sha: 'abc', name: 'deploy', status: 'running' },
        ],
      },
    })
    const { items } = await c.listCheckRuns(connection, ref, 'abc')
    expect(items[0]).toMatchObject({ name: 'build', status: 'completed', conclusion: 'success' })
    expect(items[1]).toMatchObject({
      name: 'test',
      status: 'completed',
      conclusion: 'failure',
      htmlUrl: 'http://ci/2',
    })
    expect(items[2]).toMatchObject({ name: 'deploy', status: 'in_progress', conclusion: null })
  })

  it('maps merge_status to the neutral mergeability triplet', async () => {
    const { c } = client({
      'GET /projects/7/merge_requests/3': {
        body: { merge_status: 'can_be_merged', sha: 'abc' },
      },
    })
    const m = await c.getPullRequestMergeability(connection, ref, 3)
    expect(m).toEqual({ mergeable: true, mergeableState: 'clean', headSha: 'abc' })
  })

  it('reports push access from the project access level', async () => {
    const { c } = client({
      'GET /projects/7': { body: { id: 7, permissions: { project_access: { access_level: 30 } } } },
    })
    expect(await c.canPush(connection, ref)).toBe(true)
  })

  it('opens a merge request via the MR endpoint', async () => {
    const { c, calls } = client({
      'POST /projects/7/merge_requests': {
        body: {
          id: 100,
          iid: 5,
          title: 'PR',
          state: 'opened',
          source_branch: 'feat',
          target_branch: 'main',
        },
      },
    })
    const pr = await c.openPullRequest(connection, ref, { title: 'PR', head: 'feat', base: 'main' })
    expect(pr).toMatchObject({ number: 5, state: 'open' })
    expect(calls[0]!.body).toMatchObject({
      source_branch: 'feat',
      target_branch: 'main',
      title: 'PR',
    })
  })

  it('follows Link pagination', async () => {
    const { c } = client({
      'GET /projects?membership=true&per_page=100': {
        body: [{ id: 1, path: 'a', path_with_namespace: 'g/a' }],
        headers: {
          link: '<https://gitlab.com/api/v4/projects?membership=true&per_page=100&page=2>; rel="next"',
        },
      },
      'GET /projects?membership=true&per_page=100&page=2': {
        body: [{ id: 2, path: 'b', path_with_namespace: 'g/b' }],
      },
    })
    const { items } = await c.listRepos(connection)
    expect(items.map((r) => r.githubId)).toEqual([1, 2])
  })

  it('mergeBranch is explicitly unsupported on GitLab', async () => {
    const { c } = client({})
    await expect(c.mergeBranch(connection, ref, { base: 'main', head: 'feat' })).rejects.toThrow(
      /not supported on GitLab/,
    )
  })
})

describe('GitLab webhook', () => {
  it('verifies the X-Gitlab-Token header constant-time', async () => {
    const verifier = new GitLabWebhookVerifier('s3cret')
    expect(await verifier.verify(new ArrayBuffer(0), 's3cret')).toBe(true)
    expect(await verifier.verify(new ArrayBuffer(0), 'wrong')).toBe(false)
    expect(await verifier.verify(new ArrayBuffer(0), null)).toBe(false)
  })

  it('maps a Merge Request Hook to a neutral pull-request event', () => {
    const mapper = new GitLabWebhookMapper()
    const event = mapper.map(connection, {
      eventName: 'Merge Request Hook',
      payload: {
        project: { id: 7, path_with_namespace: 'group/proj' },
        object_attributes: {
          id: 100,
          iid: 3,
          title: 'X',
          state: 'opened',
          source_branch: 'feat',
          target_branch: 'main',
          last_commit: { id: 'abc' },
        },
        user: { username: 'alice' },
      },
    })
    expect(event).toMatchObject({
      kind: 'pull-request',
      connection,
      repo: { repoId: '7', owner: 'group', repo: 'proj' },
      pullRequest: { number: 3, state: 'open', headSha: 'abc', author: 'alice' },
    })
  })

  it('maps a Pipeline Hook to a neutral ci-status event', () => {
    const mapper = new GitLabWebhookMapper()
    const event = mapper.map(connection, {
      eventName: 'Pipeline Hook',
      payload: {
        project: { id: 7, path_with_namespace: 'group/proj' },
        object_attributes: { id: 9, sha: 'abc', status: 'failed' },
      },
    })
    expect(event).toMatchObject({
      kind: 'ci-status',
      checkRun: { status: 'completed', conclusion: 'failure', headSha: 'abc' },
    })
  })
})

describe('registerGitLab', () => {
  it('registers a resolvable gitlab provider bundle', () => {
    clearVcsProviders()
    registerGitLab({ tokenSource: new StaticGitLabTokenSource('tok'), clock, webhookSecret: 's' })
    const bundle = resolveVcsProvider(connection)
    expect(bundle.provider).toBe('gitlab')
    expect(bundle.client).toBeInstanceOf(FetchGitLabClient)
    expect(bundle.webhookMapper).toBeInstanceOf(GitLabWebhookMapper)
    expect(bundle.webhookVerifier).toBeInstanceOf(GitLabWebhookVerifier)
    expect(bundle.provisioning).toBeDefined()
    clearVcsProviders()
  })
})
