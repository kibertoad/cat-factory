import { AgentKindRegistry } from '@cat-factory/agents'
import type { McpServerDefinition } from '@cat-factory/kernel'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { handleError } from '../src/http/errorHandler.js'
import { mcpOAuthCallbackController } from '../src/modules/toolServers/McpOAuthCallbackController.js'

// The vendor's redirect target. It is PUBLIC by necessity (a third party navigates a browser to
// it), so what these pin is the three things standing in for the workspace gate it cannot have: the
// sealed state, the user who STARTED the flow, and that user's permission re-checked at the moment
// the token is stored rather than assumed from the start call minutes earlier.

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
  user?: { id: string } | null
  /** The caller's workspace role, resolved the way production resolves it (never asserted in). */
  role?: 'admin' | 'member' | 'viewer'
  completed?: Completed[]
  registry?: AgentKindRegistry
}): Hono<AppEnv> {
  const registry = options.registry ?? new AgentKindRegistry()
  if (!options.registry) registry.registerToolServer(SERVER)
  const container = {
    agentKindRegistry: registry,
    config: { github: { setupRedirectUrl: 'https://app.example.com/board' } },
    // The workspace-access cache the permission re-check reads through.
    caches: {
      workspaceAccess: {
        get: async (_user: string, _ws: string, load: () => Promise<unknown>) => load(),
      },
    },
    // The permission is re-derived through the REAL resolution, not read off a context value: the
    // callback runs outside the workspace gate, so nothing has published one for it.
    workspaceService: {
      accessRowOf: async () => ({
        accountId: 'acc_1',
        ownerUserId: 'usr_owner',
        accessMode: 'restricted',
      }),
      memberRoleOf: async () => options.role ?? 'admin',
    },
    accountService: { rolesFor: async () => ['member'] },
    mcpOAuth: {
      readAuthorizationRequest: async () =>
        options.request === undefined
          ? {
              kind: 'authorization-request',
              workspaceId: 'ws_1',
              serverId: 'linear',
              userId: 'usr_1',
            }
          : options.request,
      completeAuthorization: async (_request: unknown, input: Completed) => {
        options.completed?.push(input)
      },
    },
  } as unknown as ServerContainer

  const app = new Hono<AppEnv>()
  app.onError(handleError)
  app.use('*', async (c, next) => {
    c.set('container', container)
    if (options.user !== null) c.set('user', (options.user ?? { id: 'usr_1' }) as never)
    await next()
  })
  app.route('/', mcpOAuthCallbackController())
  return app
}

describe('mcpOAuthCallbackController', () => {
  it('completes a grant and lands the browser back on the app', async () => {
    const completed: Completed[] = []
    const res = await build({ completed }).request(
      '/mcp/oauth/callback?code=abc&state=sealed',
      undefined,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://app.example.com/board')
    expect(completed).toEqual([{ code: 'abc', clientId: 'cid' }])
  })

  it('refuses a state that will not open', async () => {
    const res = await build({ request: null }).request('/mcp/oauth/callback?code=abc&state=forged')
    expect(res.status).toBe(401)
  })

  it('refuses a callback completed by someone other than whoever started the flow', async () => {
    // Without this binding, getting an admin to open an attacker's authorization link plants the
    // ATTACKER's vendor account as the board's connection.
    const completed: Completed[] = []
    const res = await build({
      request: { workspaceId: 'ws_1', serverId: 'linear', userId: 'usr_attacker' },
      user: { id: 'usr_1' },
      completed,
    }).request('/mcp/oauth/callback?code=abc&state=sealed')

    expect(res.status).toBe(401)
    expect(completed).toEqual([])
  })

  it('re-checks secrets.manage at the moment the token is stored', async () => {
    // A grant takes minutes of human time and the permission can be revoked inside that window, so
    // the start route's gate is not evidence about now.
    const completed: Completed[] = []
    const res = await build({ role: 'member', completed }).request(
      '/mcp/oauth/callback?code=abc&state=sealed',
    )
    expect(res.status).toBe(403)
    expect(completed).toEqual([])
  })

  it('reports an authorization server that refused, apart from a missing code', async () => {
    const denied = await build({}).request('/mcp/oauth/callback?error=access_denied&state=sealed')
    expect(await denied.json()).toMatchObject({
      error: { details: { reason: 'oauth_authorization_denied' } },
    })
    const noCode = await build({}).request('/mcp/oauth/callback?state=sealed')
    expect(await noCode.json()).toMatchObject({
      error: { details: { reason: 'oauth_code_missing' } },
    })
  })

  it('refuses when the declaration no longer carries OAuth', async () => {
    const res = await build({ registry: new AgentKindRegistry() }).request(
      '/mcp/oauth/callback?code=abc&state=sealed',
    )
    expect(await res.json()).toMatchObject({
      error: { details: { reason: 'tool_server_without_oauth' } },
    })
  })
})
