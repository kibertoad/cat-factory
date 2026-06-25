import type {
  GitHubRepoRef,
  IdGenerator,
  InstallationPermissions,
  RateLimitRepository,
  RateLimitSnapshot,
} from '@cat-factory/kernel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FetchGitHubClient } from '../src/github/FetchGitHubClient.js'
import type { AppTokenSource } from '../src/github/GitHubAppRegistry.js'

// canPush decides write access from the authoritative source per credential type:
//   - a GitHub App installation token isn't a repo collaborator, so the repo object's
//     `permissions.push` is empty for it — the App's granted `contents` scope from the
//     token mint response is authoritative.
//   - a user/PAT token (local mode) DOES have a role, reported in `permissions.push`.
// It also rechecks with a freshly minted token on a negative answer, defeating the
// in-memory installation-token cache (a token bakes in its grant at mint time, so one
// minted before the user granted access keeps reporting the old grant for ~1h).
// This client is shared by every facade, so this single suite guards it for all.

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

/**
 * A fake App token source. `grantsWriteAfterRefresh` simulates the real cache: the
 * granted `contents` scope reads 'read' until a fresh token is minted (forceRefresh),
 * after which it reads 'write' — i.e. the user granted access and only a fresh token
 * sees it. `installationPermissions` reflects the last-minted token, exactly as the
 * real `GitHubAppAuth` does (it reads the cache the token request just populated).
 */
function appRegistry(opts: {
  contents: 'read' | 'write' | 'grant-on-refresh'
  mints: { forceRefresh: boolean }[]
}): AppTokenSource {
  let lastForceRefresh = false
  return {
    defaultAppId: 'app',
    apps: () => [{ appId: 'app' }],
    authForApp: () => ({ appJwt: async () => 'jwt' }),
    installationToken: async (_id, o) => {
      lastForceRefresh = o?.forceRefresh === true
      opts.mints.push({ forceRefresh: lastForceRefresh })
      return 'app-token'
    },
    installationPermissions: async (): Promise<InstallationPermissions> => {
      if (opts.contents === 'grant-on-refresh') {
        return { contents: lastForceRefresh ? 'write' : 'read' }
      }
      return { contents: opts.contents }
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

describe('FetchGitHubClient.canPush', () => {
  it('App token: true from granted contents:write, even though repo permissions is empty', async () => {
    const mints: { forceRefresh: boolean }[] = []
    // App installation tokens get a repo object with no `permissions` field.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ name: 'simpler-service3' })),
    )
    await expect(makeClient(appRegistry({ contents: 'write', mints })).canPush(1, ref)).resolves.toBe(
      true,
    )
    // Already writable on the first probe — no recheck mint.
    expect(mints).toEqual([{ forceRefresh: false }])
  })

  it('App token: re-mints a fresh token and rechecks when the cached grant is stale', async () => {
    const mints: { forceRefresh: boolean }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ name: 'simpler-service3' })),
    )
    await expect(
      makeClient(appRegistry({ contents: 'grant-on-refresh', mints })).canPush(1, ref),
    ).resolves.toBe(true)
    // First probe saw the stale 'read' grant; the recheck forced a fresh mint that sees 'write'.
    expect(mints).toEqual([{ forceRefresh: false }, { forceRefresh: true }])
  })

  it('App token: false only after a fresh token still lacks contents:write', async () => {
    const mints: { forceRefresh: boolean }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ name: 'simpler-service3' })),
    )
    await expect(makeClient(appRegistry({ contents: 'read', mints })).canPush(1, ref)).resolves.toBe(
      false,
    )
    expect(mints).toEqual([{ forceRefresh: false }, { forceRefresh: true }])
  })

  it('PAT/user token: true from the repo object role (permissions.push)', async () => {
    const mints: { forceRefresh: boolean }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ permissions: { push: true } })),
    )
    // A PAT source has no granted-permissions map.
    const pat: AppTokenSource = {
      defaultAppId: '',
      apps: () => [{ appId: '' }],
      authForApp: () => ({ appJwt: async () => 'jwt' }),
      installationToken: async (_id, o) => {
        mints.push({ forceRefresh: o?.forceRefresh === true })
        return 'pat'
      },
      installationPermissions: async () => ({}),
    }
    await expect(makeClient(pat).canPush(1, ref)).resolves.toBe(true)
    expect(mints).toEqual([{ forceRefresh: false }])
  })
})
