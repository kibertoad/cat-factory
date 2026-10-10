import type { GitHubRepoRef, IdGenerator, RateLimitRepository } from '@cat-factory/kernel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FetchGitHubClient } from '../src/github/FetchGitHubClient.js'
import type { AppTokenSource } from '../src/github/GitHubAppRegistry.js'

// A repo's numeric id is immutable, so the client memoizes it per (installationId, owner,
// repo) instead of re-issuing `GET /repos/{owner}/{repo}` on every payload that omits it
// (branches / issues / commits / check runs backfill it). This pins performance-
// optimizations item 2a: the second backfill reuses the first `/repos` read.

const noopRateLimit: RateLimitRepository = {
  record: async () => {},
  deleteOlderThan: async () => 0,
}
const idGenerator: IdGenerator = { next: (p?: string) => (p ? `${p}_x` : 'x') }
const clock = { now: () => 0 }

const patRegistry: AppTokenSource = {
  defaultAppId: '',
  apps: () => [{ appId: '' }],
  authForApp: () => ({ appJwt: async () => 'jwt' }),
  installationToken: async () => 'token',
  installationPermissions: async () => ({}),
}

function makeClient(): FetchGitHubClient {
  return new FetchGitHubClient({
    registry: patRegistry,
    rateLimitRepository: noopRateLimit,
    idGenerator,
    clock,
    apiBase: 'https://api.github.com',
  })
}

/** Route by path: the repo-meta read returns an id; the branches list returns one branch. */
function routedFetch(ref: GitHubRepoRef, repoId: number): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: unknown) => {
    const path = new URL(String(input)).pathname
    if (path === `/repos/${ref.owner}/${ref.repo}`) {
      return new Response(JSON.stringify({ id: repoId }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify([{ name: 'main', commit: { sha: 'abc' } }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

const repoMetaCalls = (fn: ReturnType<typeof vi.fn>, ref: GitHubRepoRef): number =>
  fn.mock.calls.filter((c) => new URL(String(c[0])).pathname === `/repos/${ref.owner}/${ref.repo}`)
    .length

afterEach(() => vi.unstubAllGlobals())

describe('FetchGitHubClient repoId memo', () => {
  it('reads /repos once across repeated id backfills for the same repo', async () => {
    // Unique owner/repo so the process-global memo can't collide with other suites.
    const ref: GitHubRepoRef = { owner: 'memo-acme', repo: 'memo-repo' }
    const fn = routedFetch(ref, 555)
    const client = makeClient()

    const first = await client.listBranches(7, ref)
    const second = await client.listBranches(7, ref)

    expect(first.items[0]).toMatchObject({ repoGithubId: 555 })
    expect(second.items[0]).toMatchObject({ repoGithubId: 555 })
    // The `/repos` meta read happened exactly once; the second backfill hit the memo.
    expect(repoMetaCalls(fn, ref)).toBe(1)
  })
})
