import { McpAuthorizationServer, PublicApiKeyService } from '@cat-factory/integrations'
import type { PublicApiKeyRecord, PublicApiKeyRepository } from '@cat-factory/kernel'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { TOKEN_AUDIENCE, signerFor } from '../src/auth/signing.js'
import { mountAuthGate } from '../src/http/authGate.js'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { handleError } from '../src/http/errorHandler.js'
import { mcpAuthorizationConsentController } from '../src/modules/mcpAuthServer/McpAuthorizationConsentController.js'
import { mcpAuthorizationController } from '../src/modules/mcpAuthServer/McpAuthorizationController.js'
import { publicMcpController } from '../src/modules/publicApi/PublicMcpController.js'

// MCP authorization as a HOST meets it: unauthenticated discovery and exchange on one side, a
// session-gated consent screen on the other, with the real auth gate mounted between them.
//
// The gate is mounted rather than faked because reachability IS the subject. Every route here is
// either public by necessity (a host has no credential yet, which is what it came for) or gated by
// necessity (an approval that cannot say who approved is not an approval), and both halves fail
// silently in production if they are on the wrong side of it: a gated metadata document reads as a
// deployment that does not support OAuth, and an ungated approval reads as one that does.

const SESSION_SECRET = 'test-session-secret'
const ORIGIN = 'https://cat.example'
const REDIRECT = 'http://127.0.0.1:53219/callback'

class MemoryKeyRepository implements PublicApiKeyRepository {
  readonly rows = new Map<string, PublicApiKeyRecord>()
  async add(record: PublicApiKeyRecord) {
    this.rows.set(record.id, record)
  }
  async getById(id: string) {
    return this.rows.get(id) ?? null
  }
  async listByWorkspace(workspaceId: string) {
    return [...this.rows.values()].filter((row) => row.workspaceId === workspaceId)
  }
  async markUsed() {}
  async revoke() {}
  async revokeMintedBy() {}
}

function build(options: { role?: 'admin' | 'member'; appBaseUrl?: string } = {}) {
  const repository = new MemoryKeyRepository()
  const publicApiKeys = new PublicApiKeyService({
    repository,
    pepper: 'pepper-for-tests-only',
    idGenerator: { next: (prefix) => `${prefix}_${repository.rows.size + 1}` },
    clock: { now: () => Date.now() },
  })
  const container = {
    config: { auth: { enabled: true, devOpen: false, sessionSecret: SESSION_SECRET } },
    caches: {
      workspaceAccess: {
        get: async (_user: string, _ws: string, load: () => Promise<unknown>) => load(),
      },
    },
    workspaceService: {
      accessRowOf: async () => ({
        accountId: 'acc_1',
        ownerUserId: 'usr_owner',
        accessMode: 'restricted',
      }),
      memberRoleOf: async () => options.role ?? 'admin',
      accountOf: async () => 'acc_1',
    },
    accountService: { rolesFor: async () => ['member'] },
    userService: { sessionGeneration: async () => 0, refreshSessionGeneration: async () => 0 },
    publicApiKeys,
    // The REAL authorization server over a real key store: what these tests care about is that a
    // host ends up with a credential that authenticates, which a stub could not demonstrate.
    mcpAuthServer: new McpAuthorizationServer({
      secretCipher: {
        encrypt: async (value: string) => `sealed(${value})`,
        decrypt: async (value: string) => {
          const match = /^sealed\((.*)\)$/s.exec(value)
          if (!match) throw new Error('not sealed by this cipher')
          return match[1]!
        },
      },
      publicApiKeys,
      clock: { now: () => Date.now() },
    }),
    ...(options.appBaseUrl ? { appBaseUrl: options.appBaseUrl } : {}),
  } as unknown as ServerContainer

  const app = new Hono<AppEnv>()
  app.onError(handleError)
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })
  mountAuthGate(app)
  app.route('/', mcpAuthorizationController())
  app.route('/', mcpAuthorizationConsentController())
  // The hosted endpoint itself, for the challenge. Its loopback is never reached: every request
  // here is refused at the key gate, which is the point.
  app.route(
    '/',
    publicMcpController(async () => new Response('unused', { status: 500 })),
  )
  return { app, publicApiKeys, repository }
}

async function bearer(userId: string): Promise<string> {
  return signerFor(SESSION_SECRET).sign({
    sub: userId,
    id: userId,
    aud: TOKEN_AUDIENCE.session,
    exp: Date.now() + 3_600_000,
    gen: 0,
  })
}

async function json(app: Hono<AppEnv>, path: string, body: unknown, as?: string) {
  const token = as ? await bearer(as) : null
  return app.request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

async function pkce(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** Register a client and open an authorization request, as a host would. */
async function startFlow(app: Hono<AppEnv>, verifier: string) {
  const registration = await json(app, '/oauth/register', {
    client_name: 'Test Host',
    redirect_uris: [REDIRECT],
  })
  const { client_id: clientId } = (await registration.json()) as { client_id: string }
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: await pkce(verifier),
    code_challenge_method: 'S256',
    state: 'host-state',
    resource: `${ORIGIN}/api/v1/mcp`,
  })
  const redirect = await app.request(`${ORIGIN}/oauth/authorize?${query}`)
  const consent = new URL(redirect.headers.get('location')!)
  return { clientId, consent, sealedRequest: consent.searchParams.get('request')! }
}

describe('MCP authorization (serving side)', () => {
  it('answers discovery without a session, on both well-known paths', async () => {
    const { app } = build()
    for (const path of [
      '/.well-known/oauth-protected-resource/api/v1/mcp',
      '/.well-known/oauth-protected-resource',
    ]) {
      const res = await app.request(`${ORIGIN}${path}`)
      expect(res.status, path).toBe(200)
      expect(await res.json()).toMatchObject({ resource: `${ORIGIN}/api/v1/mcp` })
    }
    const server = await app.request(`${ORIGIN}/.well-known/oauth-authorization-server`)
    expect(server.status).toBe(200)
    expect(await server.json()).toMatchObject({ issuer: ORIGIN })
  })

  it('points an unauthenticated MCP call at that metadata instead of a bare 401', async () => {
    // The entry point to the whole chain. Without this header a host is told only that its
    // credential is wrong, and everything above is served, correct, and unreachable.
    const { app } = build()
    const res = await app.request(`${ORIGIN}/api/v1/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/v1/mcp", scope="read"`,
    )
  })

  it('carries a host from registration to a key that authenticates', async () => {
    const { app, publicApiKeys } = build()
    const verifier = 'a-verifier-only-the-host-has'
    const { clientId, consent, sealedRequest } = await startFlow(app, verifier)
    expect(consent.pathname).toBe('/mcp-authorize')

    // The consent screen: what a person is told, then what they decided.
    const described = await json(
      app,
      '/mcp/authorization/describe',
      { request: sealedRequest },
      'usr_1',
    )
    expect(await described.json()).toEqual({
      clientName: 'Test Host',
      redirectOrigin: 'http://127.0.0.1:53219',
    })

    const decided = await json(
      app,
      '/mcp/authorization/decision',
      { decision: 'approve', request: sealedRequest, workspaceId: 'ws_1', scope: 'write' },
      'usr_1',
    )
    const back = new URL(((await decided.json()) as { redirectTo: string }).redirectTo)
    expect(back.searchParams.get('state')).toBe('host-state')

    // The exchange, form-encoded, as OAuth specifies it.
    const token = await app.request(`${ORIGIN}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: back.searchParams.get('code')!,
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }).toString(),
    })
    expect(token.status).toBe(200)
    expect(token.headers.get('cache-control')).toBe('no-store')
    const issued = (await token.json()) as { access_token: string; token_type: string }
    expect(issued.token_type).toBe('Bearer')
    // The token model in one assertion: what a host gets is a key on the approved board.
    expect(await publicApiKeys.authenticate(issued.access_token)).toMatchObject({
      workspaceId: 'ws_1',
      scope: 'write',
    })
  })

  it('sends consent to the configured app URL when the SPA is served elsewhere', async () => {
    const { app } = build({ appBaseUrl: 'https://app.example' })
    const { consent } = await startFlow(app, 'v')
    expect(consent.origin).toBe('https://app.example')
  })

  it('refuses an approval from an anonymous caller, and from one without secrets.manage', async () => {
    const anonymous = build()
    const { sealedRequest } = await startFlow(anonymous.app, 'v')
    expect(
      (await json(anonymous.app, '/mcp/authorization/describe', { request: sealedRequest })).status,
    ).toBe(401)

    const member = build({ role: 'member' })
    const flow = await startFlow(member.app, 'v')
    const res = await json(
      member.app,
      '/mcp/authorization/decision',
      { decision: 'approve', request: flow.sealedRequest, workspaceId: 'ws_1', scope: 'admin' },
      'usr_1',
    )
    expect(res.status).toBe(403)
    expect(member.repository.rows.size).toBe(0)
  })

  it('lets anyone who can open the screen decline, without minting anything', async () => {
    // A refusal needs no permission: a person who cannot approve must still be able to answer, or
    // the host waits out its timeout with nothing said.
    const { app, repository } = build({ role: 'member' })
    const { sealedRequest } = await startFlow(app, 'v')
    const res = await json(
      app,
      '/mcp/authorization/decision',
      { decision: 'deny', request: sealedRequest },
      'usr_1',
    )
    const back = new URL(((await res.json()) as { redirectTo: string }).redirectTo)
    expect(back.searchParams.get('error')).toBe('access_denied')
    expect(repository.rows.size).toBe(0)
  })

  it('refuses an unregistered redirect on the page rather than bouncing to it', async () => {
    // Reporting this one by redirecting would BE the open redirect the registration check exists to
    // prevent: a URL on this deployment's origin that forwards a browser anywhere.
    const { app } = build()
    const registration = await json(app, '/oauth/register', {
      client_name: 'Test Host',
      redirect_uris: [REDIRECT],
    })
    const { client_id: clientId } = (await registration.json()) as { client_id: string }
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://attacker.example/collect',
      code_challenge: await pkce('v'),
      code_challenge_method: 'S256',
    })
    const res = await app.request(`${ORIGIN}/oauth/authorize?${query}`)
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
    expect(await res.json()).toMatchObject({ error: 'invalid_request' })
  })

  it('refuses a registration whose redirect would leak the code', async () => {
    const { app } = build()
    const res = await json(app, '/oauth/register', {
      client_name: 'Test Host',
      redirect_uris: ['http://host.example/callback'],
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_redirect_uri' })
  })

  it('answers the refresh grant with what it actually serves', async () => {
    // The token does not expire, so there is no refresh. A client that asks is told in the
    // protocol's own vocabulary rather than by a 404 it would read as a broken deployment.
    const { app } = build()
    const res = await app.request(`${ORIGIN}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'x' }).toString(),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'unsupported_grant_type' })
  })
})
