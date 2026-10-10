import type {
  IdGenerator,
  InstallationPermissions,
  RateLimitRepository,
  RateLimitSnapshot,
} from '@cat-factory/kernel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FetchGitHubClient } from '../src/github/FetchGitHubClient.js'
import type { AppTokenSource } from '../src/github/GitHubAppRegistry.js'

// listReposForToken enumerates the repos a personal access token can reach (`GET /user/repos`),
// backing the add-service picker's personal-repo branch. Page 1's `Link: rel="last"` header lets
// the remaining pages fetch CONCURRENTLY instead of walking `next` one blocking request at a time
// — the fix for the ~17s picker stall on a broad PAT. These specs pin that behaviour.

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

const repoPayload = (id: number) => ({
  id,
  name: `repo-${id}`,
  owner: { login: 'me' },
  default_branch: 'main',
})

/** A page of `per_page`-sized repo payloads for `?page=n`, ids stable across pages. */
function pageBody(page: number, perPage: number): unknown[] {
  return Array.from({ length: perPage }, (_, i) => repoPayload((page - 1) * perPage + i + 1))
}

function linkHeader(base: string, self: number, last: number): Record<string, string> {
  if (last <= 1) return {}
  const parts: string[] = []
  if (self < last) parts.push(`<${base}&page=${self + 1}>; rel="next"`)
  parts.push(`<${base}&page=${last}>; rel="last"`)
  return { link: parts.join(', ') }
}

afterEach(() => vi.unstubAllGlobals())

describe('FetchGitHubClient.listReposForToken', () => {
  it('fetches the trailing pages concurrently once page 1 reveals the last page', async () => {
    const base = 'https://api.github.com/user/repos?per_page=100&sort=full_name'
    let inFlight = 0
    let maxConcurrent = 0
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        seen.push(url)
        const page = Number(new URL(url).searchParams.get('page') ?? '1')
        // Page 1 resolves immediately (it gates discovery); pages 2..N overlap so we can observe
        // that they run together rather than in a blocking chain.
        if (page === 1) {
          return new Response(JSON.stringify(pageBody(1, 100)), {
            status: 200,
            headers: { 'content-type': 'application/json', ...linkHeader(base, 1, 3) },
          })
        }
        inFlight++
        maxConcurrent = Math.max(maxConcurrent, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight--
        return new Response(JSON.stringify(pageBody(page, 100)), {
          status: 200,
          headers: { 'content-type': 'application/json', ...linkHeader(base, page, 3) },
        })
      }),
    )

    const { items, truncated } = await makeClient().listReposForToken('tok')

    expect(items).toHaveLength(300)
    expect(items[0]!.linkedVia).toBe('user_pat')
    expect(truncated).toBe(false)
    // Pages 2 and 3 were in flight at the same time — not walked serially.
    expect(maxConcurrent).toBe(2)
    // Exactly pages 1, 2, 3 — bounded by `last`, no over-fetch.
    const pages = seen.map((u) => new URL(u).searchParams.get('page') ?? '1').sort()
    expect(pages).toEqual(['1', '2', '3'])
  })

  it('reports truncated when the token spans more than the page cap', async () => {
    const base = 'https://api.github.com/user/repos?per_page=100&sort=full_name'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        const page = Number(new URL(url).searchParams.get('page') ?? '1')
        // Advertise 50 total pages — far beyond MAX_PAGES (10), so the enumeration is a prefix.
        return new Response(JSON.stringify(pageBody(page, 100)), {
          status: 200,
          headers: { 'content-type': 'application/json', ...linkHeader(base, page, 50) },
        })
      }),
    )

    const { items, truncated } = await makeClient().listReposForToken('tok')

    // Capped at MAX_PAGES × PER_PAGE = 10 × 100.
    expect(items).toHaveLength(1000)
    expect(truncated).toBe(true)
  })

  it('returns the single page as-is when the token reaches few repos', async () => {
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        seen.push(url)
        // No Link header → one page, no `next`/`last`.
        return new Response(JSON.stringify([repoPayload(1), repoPayload(2)]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )

    const { items, truncated } = await makeClient().listReposForToken('tok')

    expect(items.map((r) => r.name)).toEqual(['repo-1', 'repo-2'])
    expect(truncated).toBe(false)
    expect(seen).toHaveLength(1)
  })
})
