import type {
  GitHubRepoRef,
  IdGenerator,
  RateLimitRepository,
  RateLimitSnapshot,
} from '@cat-factory/kernel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FetchGitHubClient } from '../src/github/FetchGitHubClient.js'
import type { AppTokenSource } from '../src/github/GitHubAppRegistry.js'

// canPush rechecks write access with a freshly minted token when the cached one
// reports no write — defeating the in-memory installation-token cache (a token bakes
// in its grant at mint time, so one minted before the user granted the App access
// keeps reporting the old, no-write grant for up to ~1h). This client is shared by
// every facade, so this single suite guards the behaviour for all of them.

const noopRateLimit: RateLimitRepository = {
  record: async (_snapshot: RateLimitSnapshot) => {},
  deleteOlderThan: async () => 0,
}
const idGenerator: IdGenerator = { next: (p?: string) => (p ? `${p}_x` : 'x') }
const clock = { now: () => 0 }
const ref: GitHubRepoRef = { owner: 'kibertoad', repo: 'simpler-service3' }

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** A token source that records the `forceRefresh` of each mint, returning a tagged token. */
function recordingRegistry(mints: { forceRefresh: boolean }[]): AppTokenSource {
  return {
    defaultAppId: 'app',
    apps: () => [{ appId: 'app' }],
    authForApp: () => ({ appJwt: async () => 'jwt' }),
    installationToken: async (_id, opts) => {
      const forceRefresh = opts?.forceRefresh === true
      mints.push({ forceRefresh })
      return forceRefresh ? 'fresh' : 'stale'
    },
  }
}

function makeClient(registry: AppTokenSource): FetchGitHubClient {
  return new FetchGitHubClient({
    registry,
    rateLimitRepository: noopRateLimit,
    idGenerator,
    clock,
    apiBase: 'https://api.github.com',
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('FetchGitHubClient.canPush — stale-token recheck', () => {
  it('re-mints a fresh token and rechecks when the cached token reports no write', async () => {
    const mints: { forceRefresh: boolean }[] = []
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).authorization
      // The stale token still reports the pre-grant access; a fresh token sees write.
      return jsonResponse({ permissions: { push: auth === 'Bearer fresh' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(makeClient(recordingRegistry(mints)).canPush(1, ref)).resolves.toBe(true)
    expect(mints).toEqual([{ forceRefresh: false }, { forceRefresh: true }])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not re-mint when the cached token already reports write', async () => {
    const mints: { forceRefresh: boolean }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ permissions: { push: true } })),
    )

    await expect(makeClient(recordingRegistry(mints)).canPush(1, ref)).resolves.toBe(true)
    expect(mints).toEqual([{ forceRefresh: false }])
  })

  it('returns false only after a fresh token also reports no write', async () => {
    const mints: { forceRefresh: boolean }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ permissions: { push: false } })),
    )

    await expect(makeClient(recordingRegistry(mints)).canPush(1, ref)).resolves.toBe(false)
    expect(mints).toEqual([{ forceRefresh: false }, { forceRefresh: true }])
  })
})
