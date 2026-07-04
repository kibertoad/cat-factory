import type { GitHubRepoRef, IdGenerator, RateLimitRepository } from '@cat-factory/kernel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FetchGitHubClient } from '../src/github/FetchGitHubClient.js'
import type { AppTokenSource } from '../src/github/GitHubAppRegistry.js'

// latestCommitSha is the lightweight staleness probe the fragment library uses instead
// of listing a source directory: one `GET .../commits?path=&sha=&per_page=1`, taking the
// first (newest) commit's sha. This suite pins the URL construction (path filter, the
// `HEAD`/absent → omit-sha rule so the commits endpoint uses the default branch) and the
// empty-result / 404 → null degradations. The client is shared by every facade.

const noopRateLimit: RateLimitRepository = {
  record: async () => {},
  deleteOlderThan: async () => 0,
}
const idGenerator: IdGenerator = { next: (p?: string) => (p ? `${p}_x` : 'x') }
const clock = { now: () => 0 }
const ref: GitHubRepoRef = { owner: 'acme', repo: 'guidelines' }

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

function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(
    async () =>
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

/** The request path+query the client hit (path relative to apiBase). */
function calledUrl(fn: ReturnType<typeof vi.fn>): string {
  const url = new URL(String(fn.mock.calls[0]![0]))
  return `${url.pathname}${url.search}`
}

afterEach(() => vi.unstubAllGlobals())

describe('FetchGitHubClient.latestCommitSha', () => {
  it('returns the newest commit sha and scopes the query to the dir path', async () => {
    const fn = stubFetch(200, [{ sha: 'abc123' }, { sha: 'older' }])
    await expect(makeClient().latestCommitSha(1, ref, 'guidelines', 'main')).resolves.toBe('abc123')
    expect(calledUrl(fn)).toBe('/repos/acme/guidelines/commits?per_page=1&path=guidelines&sha=main')
  })

  it('omits sha for a HEAD/absent ref so the commits endpoint uses the default branch', async () => {
    const fn = stubFetch(200, [{ sha: 'headsha' }])
    await expect(makeClient().latestCommitSha(1, ref, 'guidelines', 'HEAD')).resolves.toBe(
      'headsha',
    )
    expect(calledUrl(fn)).toBe('/repos/acme/guidelines/commits?per_page=1&path=guidelines')
  })

  it('omits the path filter for a whole-repo (empty dir) source', async () => {
    const fn = stubFetch(200, [{ sha: 'roothead' }])
    await expect(makeClient().latestCommitSha(1, ref, '')).resolves.toBe('roothead')
    expect(calledUrl(fn)).toBe('/repos/acme/guidelines/commits?per_page=1')
  })

  it('returns null on an empty result set or a 404 (no commit to pin against)', async () => {
    stubFetch(200, [])
    await expect(makeClient().latestCommitSha(1, ref, 'guidelines', 'main')).resolves.toBeNull()
    stubFetch(404, { message: 'Not Found' })
    await expect(makeClient().latestCommitSha(1, ref, 'missing', 'main')).resolves.toBeNull()
  })
})
