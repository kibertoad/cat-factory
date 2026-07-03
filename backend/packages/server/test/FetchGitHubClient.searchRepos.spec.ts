import type {
  IdGenerator,
  InstallationPermissions,
  RateLimitRepository,
  RateLimitSnapshot,
} from '@cat-factory/kernel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FetchGitHubClient } from '../src/github/FetchGitHubClient.js'
import type { AppTokenSource } from '../src/github/GitHubAppRegistry.js'

// searchInstallationRepos backs the add-service picker typeahead. With an account scope it
// issues ONE GitHub name search per query; WITHOUT a scope it must NOT run an unscoped
// global search (which would surface arbitrary unlinkable public repos) — it falls back to
// filtering the installation's own bounded listing. This client is shared by every facade.

const noopRateLimit: RateLimitRepository = {
  record: async (_snapshot: RateLimitSnapshot) => {},
  deleteOlderThan: async () => 0,
}
const idGenerator: IdGenerator = { next: (p?: string) => (p ? `${p}_x` : 'x') }
const clock = { now: () => 0 }

const registry: AppTokenSource = {
  defaultAppId: 'app',
  apps: () => [{ appId: 'app' }],
  authForApp: () => ({ appJwt: async () => 'jwt' }),
  installationToken: async () => 'app-token',
  installationPermissions: async (): Promise<InstallationPermissions> => ({ contents: 'read' }),
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** Route the fetch stub by path, recording every requested URL. */
function stubRoutes(routes: { search?: unknown[]; installationRepos?: unknown[] }): {
  urls: string[]
} {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      urls.push(url)
      if (url.includes('/search/repositories')) return jsonResponse({ items: routes.search ?? [] })
      if (url.includes('/installation/repositories')) {
        return jsonResponse({ repositories: routes.installationRepos ?? [] })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
  return { urls }
}

afterEach(() => vi.unstubAllGlobals())

describe('FetchGitHubClient.searchInstallationRepos', () => {
  it('scopes a GitHub name search to the installation account', async () => {
    const { urls } = stubRoutes({
      search: [{ id: 1, name: 'api-gateway', owner: { login: 'acme' }, default_branch: 'main' }],
    })
    const hits = await makeClient().searchInstallationRepos(1, 'acme/gateway', {
      owner: 'acme',
      ownerType: 'Organization',
    })
    expect(hits.map((r) => r.githubId)).toEqual([1])
    const searchUrl = urls.find((u) => u.includes('/search/repositories'))
    expect(searchUrl).toBeDefined()
    // Only the name segment is searched, scoped to the org — never an unscoped global query.
    const q = decodeURIComponent(new URL(searchUrl!).searchParams.get('q') ?? '')
    expect(q).toBe('gateway in:name fork:true org:acme')
  })

  it('falls back to filtering the installation listing when no account scope is available', async () => {
    const { urls } = stubRoutes({
      installationRepos: [
        { id: 1, name: 'api-gateway', owner: { login: 'acme' }, default_branch: 'main' },
        { id: 2, name: 'web-app', owner: { login: 'acme' }, default_branch: 'main' },
      ],
    })
    const hits = await makeClient().searchInstallationRepos(1, 'gateway')
    expect(hits.map((r) => r.githubId)).toEqual([1])
    // No account to scope a GitHub search to → must NOT hit the global search endpoint.
    expect(urls.some((u) => u.includes('/search/repositories'))).toBe(false)
    expect(urls.some((u) => u.includes('/installation/repositories'))).toBe(true)
  })

  it('returns [] for a blank query without any request', async () => {
    const { urls } = stubRoutes({})
    expect(await makeClient().searchInstallationRepos(1, '   ', { owner: 'acme' })).toEqual([])
    expect(urls).toEqual([])
  })
})
