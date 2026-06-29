import { describe, expect, it } from 'vitest'
import type { GitHubRepoRef } from '@cat-factory/kernel'
import { FetchGitLabClient } from './FetchGitLabClient.js'
import { StaticGitLabTokenSource } from './tokenSource.js'
import { asGitHubClient } from './vcsBackedGitHubClient.js'

// Reuse the FetchGitLabClient test's scripted-fetch shape: match by `METHOD path` and
// assert the PRIVATE-TOKEN header is always sent.
function fakeFetch(
  routes: Record<string, { status?: number; body?: unknown; headers?: Record<string, string> }>,
): { fetchImpl: typeof fetch; calls: { method: string; url: string }[] } {
  const calls: { method: string; url: string }[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString()
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = (init?.headers ?? {}) as Record<string, string>
    expect(headers['private-token']).toBe('tok')
    const path = u.replace('https://gitlab.com/api/v4', '')
    calls.push({ method, url: path })
    const route = routes[`${method} ${path}`]
    if (!route) throw new Error(`Unexpected request: ${method} ${path}`)
    return new Response(route.body === undefined ? null : JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json', ...route.headers },
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

// The GitHubClient-shaped ref the engine's gates pass; the adapter must resolve it to the
// GitLab project path (URL-encoded owner/repo, since there is no numeric repoId to hand).
const ref: GitHubRepoRef = { owner: 'group', repo: 'proj' }
const PROJECT = 'group%2Fproj'

function adapted(routes: Parameters<typeof fakeFetch>[0]) {
  const { fetchImpl, calls } = fakeFetch(routes)
  const vcs = new FetchGitLabClient({
    tokenSource: new StaticGitLabTokenSource('tok'),
    clock: { now: () => 1_000 },
    fetchImpl,
  })
  return { client: asGitHubClient({ vcs, provider: 'gitlab' }), calls }
}

describe('asGitHubClient (VcsClient → GitHubClient)', () => {
  it('routes a GitHubClient merge call to the GitLab merge-request merge endpoint', async () => {
    const { client, calls } = adapted({
      [`PUT /projects/${PROJECT}/merge_requests/7/merge`]: { body: {} },
    })
    await client.mergePullRequest(123, ref, 7)
    expect(calls.at(-1)).toEqual({
      method: 'PUT',
      url: `/projects/${PROJECT}/merge_requests/7/merge`,
    })
  })

  it('reads mergeability via the merge-request detail endpoint', async () => {
    const { client } = adapted({
      [`GET /projects/${PROJECT}/merge_requests/7`]: {
        body: {
          merge_status: 'can_be_merged',
          detailed_merge_status: 'mergeable',
          sha: 'deadbeef',
        },
      },
    })
    const m = await client.getPullRequestMergeability(123, ref, 7)
    expect(m.headSha).toBe('deadbeef')
    expect(m.mergeable).toBe(true)
  })

  it('reads the CI gate inputs (head commit + its statuses)', async () => {
    const { client } = adapted({
      [`GET /projects/${PROJECT}/repository/commits?per_page=100&ref_name=feature`]: {
        body: [{ id: 'sha1', message: 'wip', created_at: '2026-01-01T00:00:00Z' }],
      },
      [`GET /projects/${PROJECT}/repository/commits/sha1/statuses?per_page=100`]: {
        body: [{ name: 'build', status: 'success' }],
      },
    })
    const commits = await client.listCommits(123, ref, { sha: 'feature' })
    expect(commits.items[0]?.sha).toBe('sha1')
    const checks = await client.listCheckRuns(123, ref, 'sha1')
    expect(checks.items[0]?.name).toBe('build')
  })

  it('maps listInstallationRepos to the neutral repo listing', async () => {
    const { client, calls } = adapted({
      'GET /projects?membership=true&per_page=100': { body: [] },
    })
    await client.listInstallationRepos(123)
    expect(calls.at(-1)?.url).toBe('/projects?membership=true&per_page=100')
  })

  it('throws for App-installation discovery (no single-token equivalent)', async () => {
    const { client } = adapted({})
    await expect(client.getInstallation(1)).rejects.toThrow(/not supported/i)
    await expect(client.listInstallations()).rejects.toThrow(/not supported/i)
  })
})
