import type { GitHubRepoRef, IdGenerator, RateLimitRepository } from '@cat-factory/kernel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FetchGitHubClient } from '../src/github/FetchGitHubClient.js'
import type { AppTokenSource } from '../src/github/GitHubAppRegistry.js'

// listTree reads the WHOLE repo tree in one recursive git-trees call so the doc-context
// file picker can search files by path without an N+1 walk of the contents API. This
// suite pins the URL construction (recursive flag, HEAD/absent → HEAD ref), the
// blob/tree → file/dir normalisation (submodules dropped), and the 404 → [] degradation.

const noopRateLimit: RateLimitRepository = {
  record: async () => {},
  deleteOlderThan: async () => 0,
}
const idGenerator: IdGenerator = { next: (p?: string) => (p ? `${p}_x` : 'x') }
const clock = { now: () => 0 }
const ref: GitHubRepoRef = { owner: 'acme', repo: 'app' }

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

function calledUrl(fn: ReturnType<typeof vi.fn>): string {
  const url = new URL(String(fn.mock.calls[0]![0]))
  return `${url.pathname}${url.search}`
}

afterEach(() => vi.unstubAllGlobals())

describe('FetchGitHubClient.listTree', () => {
  it('reads the recursive tree and normalises blob/tree to file/dir, dropping submodules', async () => {
    const fn = stubFetch(200, {
      tree: [
        { path: 'README.md', type: 'blob', sha: 'a', size: 12 },
        { path: 'docs', type: 'tree', sha: 'b' },
        { path: 'docs/architecture.md', type: 'blob', sha: 'c', size: 34 },
        { path: 'vendored', type: 'commit', sha: 'd' },
      ],
      truncated: false,
    })
    const listing = await makeClient().listTree(1, ref, 'main')
    expect(calledUrl(fn)).toBe('/repos/acme/app/git/trees/main?recursive=1')
    expect(listing.entries).toEqual([
      { path: 'README.md', name: 'README.md', type: 'file', sha: 'a', size: 12 },
      { path: 'docs', name: 'docs', type: 'dir', sha: 'b' },
      { path: 'docs/architecture.md', name: 'architecture.md', type: 'file', sha: 'c', size: 34 },
    ])
    expect(listing.truncated).toBe(false)
  })

  // A truncated tree is a PREFIX, and the caller partitioning a codebase out of it has to be
  // able to say so: dropping the flag would let a survey report the files GitHub cut as files
  // the repository does not have.
  it('reports the provider truncating the tree', async () => {
    stubFetch(200, { tree: [{ path: 'a.ts', type: 'blob', sha: 'a', size: 1 }], truncated: true })
    await expect(makeClient().listTree(1, ref, 'main')).resolves.toMatchObject({ truncated: true })
  })

  it('resolves a HEAD/absent ref to the HEAD tree', async () => {
    const fn = stubFetch(200, { tree: [] })
    await makeClient().listTree(1, ref, 'HEAD')
    expect(calledUrl(fn)).toBe('/repos/acme/app/git/trees/HEAD?recursive=1')
    const fn2 = stubFetch(200, { tree: [] })
    await makeClient().listTree(1, ref)
    expect(calledUrl(fn2)).toBe('/repos/acme/app/git/trees/HEAD?recursive=1')
  })

  it('returns an empty, untruncated listing for an empty repo / unknown ref (404)', async () => {
    stubFetch(404, { message: 'Not Found' })
    await expect(makeClient().listTree(1, ref, 'main')).resolves.toEqual({
      entries: [],
      truncated: false,
    })
  })
})
