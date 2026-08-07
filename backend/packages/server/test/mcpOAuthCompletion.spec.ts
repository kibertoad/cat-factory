import { AgentKindRegistry } from '@cat-factory/agents'
import type { McpServerDefinition } from '@cat-factory/kernel'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { TOKEN_AUDIENCE, signerFor } from '../src/auth/signing.js'
import { mountAuthGate } from '../src/http/authGate.js'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { handleError } from '../src/http/errorHandler.js'
import { mcpOAuthCompletionController } from '../src/modules/toolServers/McpOAuthCompletionController.js'

// Finishing an OAuth grant. The vendor's redirect lands on the SPA, which re-presents `code` and
// `state` here over the authenticated API, and these pin the three things that buys:
//
//   - the route is behind the shared default-deny SESSION gate, so an auth-enabled deployment
//     refuses an anonymous caller before the handler runs. That is the property a public redirect
//     target could not have, and the reason this flow does not have one: a browser navigation the
//     VENDOR triggers carries no bearer token, so a receiver of it sees no user on every request
//     and any user-binding or permission check written there never executes;
//   - the caller must be whoever STARTED the flow;
//   - `secrets.manage` is re-resolved at the moment the token is stored, not assumed from the start
//     call minutes earlier.
//
// The gate is MOUNTED here rather than faked, because "is this route reachable at all, and by
// whom" is exactly what these are about.

const SERVER: McpServerDefinition = {
  id: 'linear',
  transport: { kind: 'http', url: 'https://mcp.linear.app/mcp' },
  oauth: { grant: 'authorization_code', clientId: 'cid' },
}

interface Completed {
  code: string
  clientId: string
  clientSecret?: string
}

function build(options: {
  request?: { workspaceId: string; serverId: string; userId: string | null } | null
  /** The caller's workspace role, resolved the way production resolves it (never asserted in). */
  role?: 'admin' | 'member' | 'viewer'
  completed?: Completed[]
  registry?: AgentKindRegistry
  /** Auth configuration, so the reachability of the route itself is under test. */
  auth?: { enabled: boolean; devOpen: boolean; sessionSecret?: string }
}): Hono<AppEnv> {
  const registry = options.registry ?? new AgentKindRegistry()
  if (!options.registry) registry.registerToolServer(SERVER)
  const container = {
    agentKindRegistry: registry,
    config: {
      auth: { enabled: true, devOpen: false, sessionSecret: SESSION_SECRET, ...options.auth },
      github: { setupRedirectUrl: 'https://app.example.com/board' },
    },
    // The workspace-access cache the permission re-check reads through.
    caches: {
      workspaceAccess: {
        get: async (_user: string, _ws: string, load: () => Promise<unknown>) => load(),
      },
    },
    // The permission is re-derived through the REAL resolution, not read off a context value: the
    // completion runs outside the workspace gate (no `:workspaceId` in the path), so nothing has
    // published one for it.
    workspaceService: {
      accessRowOf: async () => ({
        accountId: 'acc_1',
        ownerUserId: 'usr_owner',
        accessMode: 'restricted',
      }),
      memberRoleOf: async () => options.role ?? 'admin',
    },
    accountService: { rolesFor: async () => ['member'] },
    // `verifySession` checks the bearer's generation against the user row on every request.
    userService: { sessionGeneration: async () => 0, refreshSessionGeneration: async () => 0 },
    mcpOAuth: {
      readAuthorizationRequest: async (state: string | null) =>
        state && options.request === undefined
          ? {
              kind: 'authorization-request',
              workspaceId: 'ws_1',
              serverId: 'linear',
              userId: 'usr_1',
            }
          : (options.request ?? null),
      completeAuthorization: async (_request: unknown, input: Completed) => {
        options.completed?.push(input)
      },
    },
  } as unknown as ServerContainer

  const app = new Hono<AppEnv>()
  app.onError(handleError)
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })
  mountAuthGate(app)
  app.route('/', mcpOAuthCompletionController())
  return app
}

/** The session secret the staged tokens are signed with, matching the container's auth config. */
const SESSION_SECRET = 'test-session-secret'

/**
 * A real bearer token for the gate to verify, rather than a `user` planted on the context.
 *
 * The point of these tests is that the SHARED gate stands in front of this route, and a planted
 * context value would sail straight past it: `requireAuth` resolves the user from the token itself
 * and refuses when it cannot, so staging the session any other way would test a gate that is not
 * the one production runs.
 */
async function bearer(userId: string): Promise<string> {
  return signerFor(SESSION_SECRET).sign({
    sub: userId,
    id: userId,
    aud: TOKEN_AUDIENCE.session,
    // Epoch MILLISECONDS: the signer compares `exp` against `Date.now()` directly, so a
    // seconds-based claim reads as expired and every staged session silently becomes a 401.
    exp: Date.now() + 3_600_000,
    // The session generation the bearer is valid under; the fake store answers 0 for every user.
    gen: 0,
  })
}

async function post(
  app: Hono<AppEnv>,
  options: { as?: string | null } = {},
  body: unknown = { code: 'abc', state: 'sealed' },
) {
  const token = options.as ? await bearer(options.as) : null
  return app.request('/mcp/oauth/complete', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

describe('mcpOAuthCompletionController', () => {
  it('completes a grant for the user who started it', async () => {
    const completed: Completed[] = []
    const res = await post(build({ completed }), { as: 'usr_1' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ serverId: 'linear', workspaceId: 'ws_1' })
    expect(completed).toEqual([{ code: 'abc', clientId: 'cid' }])
  })

  it('is refused to an anonymous caller when auth is enabled', async () => {
    // THE regression this whole shape exists to prevent. The route the vendor used to redirect to
    // had to sit outside this gate to be reachable at all, which is what made its own session and
    // permission checks unreachable code on every deployment that has authentication.
    const completed: Completed[] = []
    const res = await post(build({ completed }))

    expect(res.status).toBe(401)
    expect(completed).toEqual([])
  })

  it('refuses a state that will not open', async () => {
    const res = await post(build({ request: null }), { as: 'usr_1' })
    expect(res.status).toBe(401)
  })

  it('refuses a completion by someone other than whoever started the flow', async () => {
    // Without this binding, getting an admin to open an attacker's authorization link would plant
    // the ATTACKER's vendor account as the board's connection.
    const completed: Completed[] = []
    const res = await post(
      build({
        request: { workspaceId: 'ws_1', serverId: 'linear', userId: 'usr_attacker' },
        completed,
      }),
      { as: 'usr_1' },
    )

    expect(res.status).toBe(401)
    expect(completed).toEqual([])
  })

  it('re-checks secrets.manage at the moment the token is stored', async () => {
    // A grant takes minutes of human time and the permission can be revoked inside that window, so
    // the start route's gate is not evidence about now.
    const completed: Completed[] = []
    const res = await post(build({ role: 'member', completed }), { as: 'usr_1' })

    expect(res.status).toBe(403)
    expect(completed).toEqual([])
  })

  it('completes under dev-open, where there is no user to bind to', async () => {
    // An absent user is SOUND here only because the gate above refuses one when auth is on, so it
    // can only mean auth is unconfigured — the same reading `requirePermission` takes.
    const completed: Completed[] = []
    const res = await post(
      build({
        auth: { enabled: false, devOpen: true, sessionSecret: '' },
        request: { workspaceId: 'ws_1', serverId: 'linear', userId: null },
        completed,
      }),
    )

    expect(res.status).toBe(200)
    expect(completed).toEqual([{ code: 'abc', clientId: 'cid' }])
  })

  it('refuses when the declaration no longer carries OAuth', async () => {
    const res = await post(build({ registry: new AgentKindRegistry() }), { as: 'usr_1' })
    expect(await res.json()).toMatchObject({
      error: { details: { reason: 'tool_server_without_oauth' } },
    })
  })
})
