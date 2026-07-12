import type {
  GitHubRepoRef,
  IdGenerator,
  RateLimitRepository,
  RateLimitSnapshot,
} from '@cat-factory/kernel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FetchGitHubClient, GitHubApiError } from '../src/github/FetchGitHubClient.js'
import type { AppTokenSource } from '../src/github/GitHubAppRegistry.js'

// The kernel `describeVcsApiError` helper is unit-tested in isolation; this suite guards that
// the SHARED client actually routes its non-2xx responses through it (C1/C6) — a plain
// `GitHub GET … → 401` dump would still throw, just without the remedy — and that the
// installation-not-found path (C5) carries its own remedy. This client backs every facade.

const noopRateLimit: RateLimitRepository = {
  record: async (_snapshot: RateLimitSnapshot) => {},
  deleteOlderThan: async () => 0,
}
const idGenerator: IdGenerator = { next: (p?: string) => (p ? `${p}_x` : 'x') }
const clock = { now: () => 0 }
const ref: GitHubRepoRef = { owner: 'kibertoad', repo: 'cat-factory' }

const registry: AppTokenSource = {
  defaultAppId: 'app',
  apps: () => [{ appId: 'app' }],
  authForApp: () => ({ appJwt: async () => 'jwt' }),
  installationToken: async () => 'token',
  installationPermissions: async () => ({}),
}

function makeClient(): FetchGitHubClient {
  return new FetchGitHubClient({
    registry,
    rateLimitRepository: noopRateLimit,
    idGenerator,
    clock,
    apiBase: 'https://api.github.com',
  })
}

function errorResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response('nope', { status, headers })
}

afterEach(() => vi.unstubAllGlobals())

describe('FetchGitHubClient error messages', () => {
  it('routes a 401 through the classifier — token-rejected remedy, raw line still first', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => errorResponse(401)),
    )
    const err = await makeClient()
      .getRepo(1, ref)
      .catch((e) => e)
    expect(err).toBeInstanceOf(GitHubApiError)
    expect((err as GitHubApiError).status).toBe(401) // identity unchanged
    expect(err.message.split('\n')[0]).toContain('→ 401') // raw detail line preserved
    expect(err.message).toContain('token was rejected')
  })

  it('detects an exhausted rate limit from headers → rate-limit remedy naming the reset', async () => {
    const resetSec = 1_800_000 // arbitrary epoch-seconds
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        errorResponse(403, {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(resetSec),
        }),
      ),
    )
    const err = await makeClient()
      .getRepo(1, ref)
      .catch((e) => e)
    expect(err.message).toContain('rate limit was exceeded')
    expect(err.message).toContain(new Date(resetSec * 1000).toISOString())
    expect(err.message).not.toContain('lacks a required permission')
  })

  it('a 403 with remaining quota → missing-scope remedy (not the rate-limit one)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => errorResponse(403, { 'x-ratelimit-remaining': '4999' })),
    )
    const err = await makeClient()
      .getRepo(1, ref)
      .catch((e) => e)
    expect(err.message).toContain('lacks a required permission or scope')
    expect(err.message).not.toContain('rate limit was exceeded')
  })

  it('C5: installation-not-found carries its own reconnect remedy + doc link', async () => {
    // Every configured App JWT 404s the installation → the aggregate not-found is thrown.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => errorResponse(404)),
    )
    const err = await makeClient()
      .getInstallation(42)
      .catch((e) => e)
    expect(err).toBeInstanceOf(GitHubApiError)
    expect((err as GitHubApiError).status).toBe(404)
    expect(err.message).toContain('not found on any configured App')
    expect(err.message).toContain('reconnect GitHub')
    expect(err.message).toContain('backend/docs/github-integration.md')
  })
})
