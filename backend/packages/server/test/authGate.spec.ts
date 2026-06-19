import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { TOKEN_AUDIENCE, HmacSigner, type SessionPayload } from '../src/auth/signing.js'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { mountAuthGate } from '../src/http/authGate.js'

// Unit-test the shared gate directly with a faked container — including the
// per-workspace authz branch, which the facade integration suites can only reach with
// a real session + datastore. The Node/Worker facades both call mountAuthGate, so this
// is the single source of truth for default-deny + public-bypass + ownership rules.

const SECRET = 's'.repeat(32)

interface FakeOpts {
  enabled?: boolean
  devOpen?: boolean
  accountOf?: (id: string) => Promise<string | null | undefined>
  ownerOf?: (id: string) => Promise<number | null | undefined>
  isMember?: (accountId: string, userId: number) => Promise<boolean>
}

function makeApp(opts: FakeOpts = {}) {
  const container = {
    config: {
      auth: {
        enabled: opts.enabled ?? true,
        devOpen: opts.devOpen ?? false,
        sessionSecret: SECRET,
      },
    },
    workspaceService: {
      accountOf: opts.accountOf ?? (async () => undefined),
      ownerOf: opts.ownerOf ?? (async () => undefined),
    },
    accountService: { isMember: opts.isMember ?? (async () => false) },
  } as unknown as ServerContainer

  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })
  mountAuthGate(app)
  app.all('*', (c) => c.text('ok'))

  return (method: string, path: string, token?: string) =>
    app.fetch(
      new Request(`https://t.test${path}`, {
        method,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      }),
    )
}

async function sessionToken(id: number): Promise<string> {
  const payload: SessionPayload = {
    id,
    login: 'octocat',
    name: null,
    avatarUrl: null,
    aud: TOKEN_AUDIENCE.session,
    exp: Date.now() + 3_600_000,
  }
  return new HmacSigner(SECRET).sign(payload)
}

describe('mountAuthGate — default-deny', () => {
  it('allows /health and public prefixes, denies protected routes without a session', async () => {
    const call = makeApp()
    expect((await call('GET', '/health')).status).toBe(200)
    expect((await call('GET', '/auth/login')).status).toBe(200)
    expect((await call('GET', '/v1/chat')).status).toBe(200)
    expect((await call('GET', '/workspaces')).status).toBe(401)
  })

  it('fails closed (503) when auth is unconfigured and dev-open is off', async () => {
    const call = makeApp({ enabled: false, devOpen: false })
    expect((await call('GET', '/workspaces')).status).toBe(503)
  })

  it('passes through when dev-open is on', async () => {
    const call = makeApp({ enabled: false, devOpen: true })
    expect((await call('GET', '/workspaces')).status).toBe(200)
  })
})

describe('mountAuthGate — per-workspace authz', () => {
  it('skips the unscoped /workspaces collection', async () => {
    const call = makeApp()
    expect((await call('GET', '/workspaces', await sessionToken(1))).status).toBe(200)
  })

  it('lets the handler 404 a missing board (accountOf undefined)', async () => {
    const call = makeApp({ accountOf: async () => undefined })
    expect((await call('GET', '/workspaces/ws_x/blocks', await sessionToken(1))).status).toBe(200)
  })

  it('legacy board: only the owner may access it (else 404)', async () => {
    const owned = makeApp({ accountOf: async () => null, ownerOf: async () => 1 })
    expect((await owned('GET', '/workspaces/ws_x', await sessionToken(1))).status).toBe(200)
    const foreign = makeApp({ accountOf: async () => null, ownerOf: async () => 2 })
    const res = await foreign('GET', '/workspaces/ws_x', await sessionToken(1))
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found')
  })

  it('account board: members pass, non-members get 404 (existence not leaked)', async () => {
    const member = makeApp({ accountOf: async () => 'acc_1', isMember: async () => true })
    expect((await member('GET', '/workspaces/ws_x', await sessionToken(1))).status).toBe(200)
    const outsider = makeApp({ accountOf: async () => 'acc_1', isMember: async () => false })
    expect((await outsider('GET', '/workspaces/ws_x', await sessionToken(1))).status).toBe(404)
  })
})
