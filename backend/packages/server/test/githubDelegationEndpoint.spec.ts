import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { HmacSigner, TOKEN_AUDIENCE } from '../src/auth/signing.js'
import { mintMachineToken } from '../src/auth/machineToken.js'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { handleError } from '../src/http/errorHandler.js'
import { githubDelegationController } from '../src/modules/persistence/GitHubDelegationController.js'
import { DelegatedAppTokenSource } from '../src/github/DelegatedAppTokenSource.js'

// The mothership-mode GitHub delegation endpoint (`POST /internal/github/installation-token`):
// a machine-authed mothership-mode node mints the short-lived GitHub App installation tokens
// its agent containers / gates / RepoFiles ops run on. Verify the machine-token audience pin,
// the installation→workspace→account scope binding (404, no existence leak), the 503 on a
// non-mothership / no-App facade, and the client-side DelegatedAppTokenSource round-trip
// (memoisation + forceRefresh pass-through).

const SECRET = 'test-session-secret-0123456789'
const ACCOUNT = 'acc_1'
const OTHER_ACCOUNT = 'acc_2'

// Installation 11 fans out to a workspace owned by ACCOUNT (in scope); 22 only to
// OTHER_ACCOUNT's workspace; 33 is unknown (no workspaces at all).
const WORKSPACE_ACCOUNTS: Record<string, string> = { ws_in: ACCOUNT, ws_out: OTHER_ACCOUNT }
const INSTALLATION_WORKSPACES: Record<number, string[]> = { 11: ['ws_in'], 22: ['ws_out'], 33: [] }

function makeApp(
  opts: { mothership?: boolean; delegation?: boolean; mintedTokens?: string[] } = {},
) {
  const minted = opts.mintedTokens ?? []
  const container = {
    repositories:
      opts.mothership === false
        ? undefined
        : {
            githubInstallationRepository: {
              listWorkspacesForInstallation: async (id: number) =>
                INSTALLATION_WORKSPACES[id] ?? [],
            },
            workspaceRepository: {
              accountOf: async (ws: string) => WORKSPACE_ACCOUNTS[ws],
            },
          },
    ...(opts.delegation === false
      ? {}
      : {
          githubTokenDelegation: {
            installationToken: async (id: number, o?: { forceRefresh?: boolean }) => {
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
  app.route('/', githubDelegationController())
  app.onError(handleError)
  return app
}

async function machineToken(accountIds = [ACCOUNT]) {
  return (await mintMachineToken(SECRET, { userId: 'usr_1', accountIds })).token
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

  it('passes forceRefresh through to the mothership mint', async () => {
    const res = await mint(makeApp(), await machineToken(), {
      installationId: 11,
      forceRefresh: true,
    })
    expect(((await res.json()) as { token: string }).token).toMatch(/^ghs_11_fresh/)
  })

  it('refuses an installation owned only by an out-of-scope account (404, no leak)', async () => {
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
