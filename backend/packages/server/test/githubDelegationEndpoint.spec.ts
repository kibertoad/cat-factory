import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { GitHubInstallation, GitHubRepo } from '@cat-factory/kernel'
import { HmacSigner, TOKEN_AUDIENCE } from '../src/auth/signing.js'
import { mintMachineToken } from '../src/auth/machineToken.js'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { handleError } from '../src/http/errorHandler.js'
import {
  githubDelegationController,
  type GitHubDelegationControllerOptions,
} from '../src/modules/persistence/GitHubDelegationController.js'
import { DelegatedAppTokenSource } from '../src/github/DelegatedAppTokenSource.js'

// The mothership-mode GitHub delegation endpoint (`POST /internal/github/installation-token`):
// a machine-authed mothership-mode node mints the short-lived GitHub App installation tokens
// its agent containers / gates / RepoFiles ops run on. Verify the machine-token audience pin
// (missing / wrong-audience / expired / wrong-secret tokens), the installation→account scope
// binding (uniform 404, no existence leak), the REPO-SCOPING of the mint (`repository_ids`
// from the live App-linked projection; nothing linked → 404), the per-node rate limit, the
// 503 on a non-mothership / no-App facade, and the client-side DelegatedAppTokenSource
// round-trip (memoisation + forceRefresh pass-through).

const SECRET = 'test-session-secret-0123456789'
const ACCOUNT = 'acc_1'
const OTHER_ACCOUNT = 'acc_2'

function installation(
  installationId: number,
  accountId: string | null,
  deletedAt: number | null = null,
): GitHubInstallation {
  return {
    installationId,
    workspaceId: `ws_${installationId}`,
    accountId,
    accountLogin: 'org',
    targetType: 'Organization',
    appId: null,
    cachedToken: null,
    tokenExpiresAt: null,
    createdAt: 1,
    deletedAt,
  }
}

function repo(
  githubId: number,
  installationId: number,
  linkedVia?: 'app' | 'user_pat',
): GitHubRepo {
  return {
    githubId,
    installationId,
    owner: 'org',
    name: `repo-${githubId}`,
    defaultBranch: 'main',
    private: true,
    ...(linkedVia ? { linkedVia } : {}),
    syncedAt: 1,
  }
}

// 11 is ACCOUNT's live installation with linked repos: 101 twice (two workspaces link it),
// 102 only via a member's PAT (NOT App-reachable), 103 via the App. 22 belongs to
// OTHER_ACCOUNT; 33 is unknown; 44 is ACCOUNT's but projects no repos; 55 is ACCOUNT's but
// tombstoned (uninstalled).
const INSTALLATIONS: Record<number, GitHubInstallation> = {
  11: installation(11, ACCOUNT),
  22: installation(22, OTHER_ACCOUNT),
  44: installation(44, ACCOUNT),
  55: installation(55, ACCOUNT, 999),
}
const INSTALLATION_REPOS: Record<number, GitHubRepo[]> = {
  11: [repo(101, 11), repo(101, 11), repo(102, 11, 'user_pat'), repo(103, 11, 'app')],
  22: [repo(201, 22)],
  44: [],
  55: [repo(501, 55)],
}

interface MintCall {
  installationId: number
  forceRefresh?: boolean
  repositoryIds?: number[]
}

function makeApp(
  opts: {
    mothership?: boolean
    delegation?: boolean
    mintedTokens?: string[]
    mintCalls?: MintCall[]
    controller?: GitHubDelegationControllerOptions
  } = {},
) {
  const minted = opts.mintedTokens ?? []
  const mintCalls = opts.mintCalls ?? []
  const container = {
    repositories:
      opts.mothership === false
        ? undefined
        : {
            githubInstallationRepository: {
              getByInstallationId: async (id: number) => INSTALLATIONS[id] ?? null,
            },
            repoProjectionRepository: {
              listByInstallation: async (id: number) => INSTALLATION_REPOS[id] ?? [],
            },
          },
    ...(opts.delegation === false
      ? {}
      : {
          githubTokenDelegation: {
            installationToken: async (
              id: number,
              o?: { forceRefresh?: boolean; repositoryIds?: number[] },
            ) => {
              mintCalls.push({
                installationId: id,
                forceRefresh: o?.forceRefresh,
                repositoryIds: o?.repositoryIds,
              })
              const token = `ghs_${id}_${o?.forceRefresh ? 'fresh' : 'cached'}_${minted.length}`
              minted.push(token)
              return token
            },
          },
        }),
    config: { auth: { sessionSecret: SECRET } },
  } as unknown as ServerContainer
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })
  app.route('/', githubDelegationController(opts.controller))
  app.onError(handleError)
  return app
}

async function machineToken(
  accountIds = [ACCOUNT],
  opts: { nodeId?: string; ttlMs?: number } = {},
) {
  return (await mintMachineToken(SECRET, { userId: 'usr_1', accountIds, ...opts })).token
}

function mint(app: Hono<AppEnv>, token: string | undefined, body: unknown) {
  return app.fetch(
    new Request('http://x/internal/github/installation-token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  )
}

describe('POST /internal/github/installation-token', () => {
  it('mints an installation token for an in-scope installation', async () => {
    const res = await mint(makeApp(), await machineToken(), { installationId: 11 })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { token: string }).token).toMatch(/^ghs_11_cached/)
  })

  it('repo-scopes the mint to the deduped, App-linked projection (repository_ids)', async () => {
    const mintCalls: MintCall[] = []
    const res = await mint(makeApp({ mintCalls }), await machineToken(), { installationId: 11 })
    expect(res.status).toBe(200)
    expect(mintCalls).toHaveLength(1)
    // 101 appears twice in the projection (two workspaces link it) → deduped; 102 is
    // `user_pat` (not App-reachable) → excluded; 103 is App-linked → included.
    expect(mintCalls[0]!.repositoryIds).toEqual([101, 103])
  })

  it('refuses an in-scope installation with NO linked repos (404 — nothing to grant)', async () => {
    const mintCalls: MintCall[] = []
    const res = await mint(makeApp({ mintCalls }), await machineToken(), { installationId: 44 })
    expect(res.status).toBe(404)
    expect(mintCalls).toHaveLength(0)
  })

  it('refuses a tombstoned (uninstalled) installation (404)', async () => {
    const res = await mint(makeApp(), await machineToken(), { installationId: 55 })
    expect(res.status).toBe(404)
  })

  it('passes forceRefresh through to the mothership mint', async () => {
    const res = await mint(makeApp(), await machineToken(), {
      installationId: 11,
      forceRefresh: true,
    })
    expect(((await res.json()) as { token: string }).token).toMatch(/^ghs_11_fresh/)
  })

  it('refuses an installation owned by an out-of-scope account (404, no leak)', async () => {
    const res = await mint(makeApp(), await machineToken(), { installationId: 22 })
    expect(res.status).toBe(404)
  })

  it('refuses an unknown installation (404, no leak)', async () => {
    const res = await mint(makeApp(), await machineToken(), { installationId: 33 })
    expect(res.status).toBe(404)
  })

  it('rejects a missing/invalid machine token (403) before any availability probe', async () => {
    expect((await mint(makeApp(), undefined, { installationId: 11 })).status).toBe(403)
    // Even a facade with NO delegation wired must 403 first — availability is not probeable
    // without a valid token (and it is what the shared conformance assertion pins).
    const bare = makeApp({ mothership: false, delegation: false })
    expect((await mint(bare, undefined, { installationId: 11 })).status).toBe(403)
  })

  it('rejects a non-machine audience token (403)', async () => {
    // A user session can never be replayed against the delegation mint.
    const session = await new HmacSigner(SECRET).sign({
      id: 'usr_1',
      login: 'dev',
      name: 'Dev',
      avatarUrl: null,
      aud: TOKEN_AUDIENCE.session,
      exp: Date.now() + 60_000,
    })
    expect((await mint(makeApp(), session, { installationId: 11 })).status).toBe(403)
  })

  it('rejects an EXPIRED machine token (403)', async () => {
    // Well-formed, correctly signed, in-scope — but past its exp claim.
    const expired = await machineToken([ACCOUNT], { ttlMs: -60_000 })
    expect((await mint(makeApp(), expired, { installationId: 11 })).status).toBe(403)
  })

  it('rejects a machine token signed under a DIFFERENT secret (403 — bad MAC)', async () => {
    // Valid token shape and machine audience, but the MAC does not verify under the
    // mothership's session secret.
    const forged = (
      await mintMachineToken('another-secret-9876543210', {
        userId: 'usr_1',
        accountIds: [ACCOUNT],
      })
    ).token
    expect((await mint(makeApp(), forged, { installationId: 11 })).status).toBe(403)
  })

  it('rate-limits mints per node (fixed window, keyed by the authenticated nodeId)', async () => {
    const nowRef = { now: 1_000_000 }
    const app = makeApp({
      controller: { rateLimit: { limit: 2, windowMs: 60_000 }, now: () => nowRef.now },
    })
    // One token = one nodeId; every mint under it counts against the same window.
    const token = await machineToken([ACCOUNT], { nodeId: 'node_a' })
    expect((await mint(app, token, { installationId: 11 })).status).toBe(200)
    expect((await mint(app, token, { installationId: 11 })).status).toBe(200)
    expect((await mint(app, token, { installationId: 11 })).status).toBe(429)
    // A DIFFERENT node is not throttled by node_a's window…
    const other = await machineToken([ACCOUNT], { nodeId: 'node_b' })
    expect((await mint(app, other, { installationId: 11 })).status).toBe(200)
    // …and node_a mints again once its window rolls over.
    nowRef.now += 60_000
    expect((await mint(app, token, { installationId: 11 })).status).toBe(200)
  })

  it('503s on a facade that is not a mothership or has no GitHub App', async () => {
    const token = await machineToken()
    expect((await mint(makeApp({ mothership: false }), token, { installationId: 11 })).status).toBe(
      503,
    )
    expect((await mint(makeApp({ delegation: false }), token, { installationId: 11 })).status).toBe(
      503,
    )
  })

  it('422s a missing or non-integer installationId', async () => {
    const token = await machineToken()
    expect((await mint(makeApp(), token, {})).status).toBe(422)
    expect((await mint(makeApp(), token, { installationId: 'x' })).status).toBe(422)
    expect((await mint(makeApp(), token, { installationId: 1.5 })).status).toBe(422)
  })
})

describe('DelegatedAppTokenSource (client side)', () => {
  function makeSource(mintedTokens: string[], nowRef: { now: number }) {
    const app = makeApp({ mintedTokens })
    const fetchImpl: typeof fetch = async (input, init) =>
      app.fetch(new Request(input as RequestInfo, init))
    return new DelegatedAppTokenSource(
      { baseUrl: 'http://mothership.test', token: () => 'machine-token-below', fetchImpl },
      () => nowRef.now,
    )
  }

  // The in-process app verifies real tokens, so give the client a REAL machine token via a
  // provider closure (resolved per request, like the production connect flow).
  async function makeAuthedSource(mintedTokens: string[], nowRef: { now: number }) {
    const app = makeApp({ mintedTokens })
    const token = await machineToken()
    const fetchImpl: typeof fetch = async (input, init) =>
      app.fetch(new Request(input as RequestInfo, init))
    return new DelegatedAppTokenSource(
      { baseUrl: 'http://mothership.test', token: () => token, fetchImpl },
      () => nowRef.now,
    )
  }

  it('memoises a minted token briefly and re-mints after the memo lapses', async () => {
    const mintedTokens: string[] = []
    const nowRef = { now: 1_000 }
    const source = await makeAuthedSource(mintedTokens, nowRef)

    const first = await source.installationToken(11)
    const second = await source.installationToken(11)
    expect(second).toBe(first)
    expect(mintedTokens).toHaveLength(1)

    nowRef.now += 120_000
    await source.installationToken(11)
    expect(mintedTokens).toHaveLength(2)
  })

  it('forceRefresh bypasses the memo and passes through to the mothership', async () => {
    const mintedTokens: string[] = []
    const nowRef = { now: 1_000 }
    const source = await makeAuthedSource(mintedTokens, nowRef)

    await source.installationToken(11)
    const fresh = await source.installationToken(11, { forceRefresh: true })
    expect(fresh).toMatch(/^ghs_11_fresh/)
    expect(mintedTokens).toHaveLength(2)
    // The refreshed token replaces the memo entry.
    expect(await source.installationToken(11)).toBe(fresh)
  })

  it('surfaces the mothership refusal as a thrown error (no token fabricated)', async () => {
    const mintedTokens: string[] = []
    const nowRef = { now: 1_000 }
    const source = makeSource(mintedTokens, nowRef) // bogus machine token → 403
    await expect(source.installationToken(11)).rejects.toThrow(/machine token|HTTP 403/)
    expect(mintedTokens).toHaveLength(0)
  })

  it('never serves the app-JWT paths (the App key stays on the mothership)', async () => {
    const source = makeSource([], { now: 0 })
    await expect(source.authForApp().appJwt()).rejects.toThrow(/mothership/)
    await expect(source.installationPermissions()).resolves.toEqual({})
  })
})
