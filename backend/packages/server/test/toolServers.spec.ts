import { AgentKindRegistry } from '@cat-factory/agents'
import type { McpServerDefinition, ToolSecretResolver } from '@cat-factory/kernel'
import { createRecordingLogger } from '@cat-factory/kernel'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { handleError } from '../src/http/errorHandler.js'
import { collectDeclaredToolServers } from '../src/modules/toolServers/declaredToolServers.js'
import { probeToolServer } from '../src/modules/toolServers/probeToolServer.js'
import { toolServerController } from '../src/modules/toolServers/ToolServerController.js'

// The tool-server OPERABILITY surface: the inventory projection, the probe's own judgements, and the
// controller's gate.
//
// Every case here is a state that was previously invisible or only visible by starting a run: a
// registration attached to no kind, a credential the deployment declares but this board has not
// stored, an `allowedTools` entry naming a tool the server does not have. The protocol layer is
// pinned separately in `mcpProbe.spec.ts`; what these drive is the DECISIONS around it.

const HTTP_SERVER: McpServerDefinition = {
  id: 'issues',
  label: 'Issue tracker',
  guidance: 'Search the tracker before guessing at an issue number.',
  transport: { kind: 'http', url: 'https://mcp.example/rpc', headers: { 'x-tenant': 'acme' } },
  allowedTools: ['search_issues', 'get_issue'],
  secretKeys: [
    {
      key: 'ACME_TRACKER_TOKEN',
      header: 'Authorization',
      headerTemplate: 'Bearer {value}',
      usage: 'A tracker API token with read scope.',
    },
  ],
}

const STDIO_SERVER: McpServerDefinition = {
  id: 'advisories',
  transport: { kind: 'stdio', command: 'npx', args: ['-y', 'acme-advisories-mcp'] },
}

function registryWith(build: (registry: AgentKindRegistry) => void): AgentKindRegistry {
  const registry = new AgentKindRegistry()
  build(registry)
  return registry
}

/** A resolver answering exactly `values`, so an unlisted key is genuinely unresolved. */
function resolverFor(values: Record<string, string>): ToolSecretResolver {
  return {
    resolve: async ({ keys }) =>
      Object.fromEntries(keys.filter((k) => values[k.key]).map((k) => [k.key, values[k.key]!])),
  }
}

describe('collectDeclaredToolServers', () => {
  it('projects a declaration non-secretly, naming every kind it reaches', () => {
    const registry = registryWith((r) => {
      r.registerToolServer(HTTP_SERVER)
      r.assignToolServers('coder', ['issues'])
      r.register({ kind: 'auditor', systemPrompt: 'p', toolServers: ['issues'] })
    })

    const [view] = collectDeclaredToolServers({ agentKindRegistry: registry })

    expect(view).toEqual({
      id: 'issues',
      label: 'Issue tracker',
      transport: 'http',
      target: 'https://mcp.example/rpc',
      guidance: 'Search the tracker before guessing at an issue number.',
      // Both attachment paths, and `coder` — a built-in that is not a registry entry — is exactly
      // the case an `all()` walk would have missed.
      declaredBy: ['auditor', 'coder'],
      servableHarnesses: ['claude-code'],
      allowedTools: ['search_issues', 'get_issue'],
      credentials: [
        {
          key: 'ACME_TRACKER_TOKEN',
          required: true,
          usage: 'A tracker API token with read scope.',
        },
      ],
      probeable: true,
    })
  })

  it('reports a registration no kind declares, with an empty declaredBy', () => {
    // The state nothing else in the platform can see: boot validation reaches a definition THROUGH
    // a kind, so an orphan registration passes every check while its credential sits in the
    // operator's checklist as a key no dispatch will ever ask for.
    const registry = registryWith((r) => r.registerToolServer(HTTP_SERVER))

    const [view] = collectDeclaredToolServers({ agentKindRegistry: registry })

    expect(view).toMatchObject({ id: 'issues', declaredBy: [] })
  })

  it('names why each unprobeable transport cannot be reached from here', () => {
    const registry = registryWith((r) =>
      r.registerToolServers([
        STDIO_SERVER,
        { id: 'sidecar', transport: { kind: 'http', url: 'http://127.0.0.1:9000/rpc' } },
        { id: 'cleartext', transport: { kind: 'http', url: 'http://mcp.example/rpc' } },
      ]),
    )

    const views = collectDeclaredToolServers({ agentKindRegistry: registry })

    // Three different answers, because three different operator responses: nothing to fix, verify
    // from a run, and change the declaration.
    expect(views.map((v) => [v.id, v.probeable, v.notProbeableReason])).toEqual([
      ['advisories', false, 'stdio_transport'],
      ['cleartext', false, 'url_not_allowed'],
      ['sidecar', false, 'container_local_url'],
    ])
  })

  it('reports an empty servableHarnesses for a declaration no harness can serve', () => {
    // An `http` server narrowed to Codex, whose MCP client is stdio-only. It never applies to any
    // run and is never dropped FOR A REASON, so no prompt or log line mentions it — boot warns, and
    // this is the only place an operator can see it.
    const registry = registryWith((r) =>
      r.registerToolServer({ ...HTTP_SERVER, harnesses: ['codex'] }),
    )

    expect(collectDeclaredToolServers({ agentKindRegistry: registry })[0]).toMatchObject({
      servableHarnesses: [],
    })
  })

  it('strips userinfo out of a url before it reaches a browser', () => {
    const registry = registryWith((r) =>
      r.registerToolServer({
        id: 'inline-cred',
        transport: { kind: 'http', url: 'https://user:s3cret@mcp.example/rpc' },
      }),
    )

    const [view] = collectDeclaredToolServers({ agentKindRegistry: registry })

    expect(view!.target).not.toContain('s3cret')
    expect(view!.target).toBe('https://mcp.example/rpc')
  })

  it('renders a stdio declaration as its command line, scrubbed', () => {
    const registry = registryWith((r) =>
      r.registerToolServers([
        STDIO_SERVER,
        {
          id: 'inline-argv',
          transport: {
            kind: 'stdio',
            command: 'npx',
            args: ['-y', 'acme-mcp', '--api-key=sk-live-abcdef1234567890'],
          },
        },
      ]),
    )

    const views = collectDeclaredToolServers({ agentKindRegistry: registry })

    expect(views[0]).toMatchObject({ target: 'npx -y acme-advisories-mcp' })
    // A command line is a place a credential legitimately sits, and the more tempting of the two for
    // a deployment that has not found `secretKeys` yet. Stored values are write-only, so this row is
    // the one place on the surface where a pasted secret could be READ back.
    expect(views[1]!.target).not.toContain('sk-live-abcdef1234567890')
  })
})

describe('probeToolServer', () => {
  const okResponses = (tools: string[], nextCursor?: string) => {
    let call = 0
    return (async () => {
      call++
      if (call === 1) {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              serverInfo: { name: 'tracker-mcp', version: '1.0.0' },
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      }
      if (call === 2) return new Response(null, { status: 202 })
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: {
            tools: tools.map((name) => ({ name })),
            ...(nextCursor ? { nextCursor } : {}),
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
  }

  it('sends the resolved credential through its declared header template', async () => {
    const sent: Record<string, string>[] = []
    const inner = okResponses(['search_issues', 'get_issue'])
    const doFetch = (async (url: string, init?: RequestInit) => {
      sent.push((init?.headers ?? {}) as Record<string, string>)
      return (inner as unknown as (u: string, i?: RequestInit) => Promise<Response>)(url, init)
    }) as unknown as typeof fetch
    const registry = registryWith((r) => {
      r.registerToolServer(HTTP_SERVER)
      r.assignToolServers('coder', ['issues'])
    })

    const result = await probeToolServer({
      agentKindRegistry: registry,
      workspaceId: 'ws_1',
      serverId: 'issues',
      resolveToolSecrets: resolverFor({ ACME_TRACKER_TOKEN: 'tok-123' }),
      probe: { fetch: doFetch },
    })

    expect(result).toMatchObject({
      serverId: 'issues',
      status: 'ok',
      serverName: 'tracker-mcp',
      serverVersion: '1.0.0',
      protocolVersion: '2025-06-18',
      toolCount: 2,
      toolsComplete: true,
      // Both narrowed names exist, so nothing is unmatched.
      allowedTools: { declared: ['search_issues', 'get_issue'], unmatched: [], checked: true },
    })
    // The declaration's non-secret header rides along beside the credential, so the probe reaches
    // the server the way a dispatch would.
    expect(sent[0]!.Authorization ?? sent[0]!.authorization).toBe('Bearer tok-123')
    expect(sent[0]!['x-tenant']).toBe('acme')
  })

  it('names an allowedTools entry the server does not expose', async () => {
    const registry = registryWith((r) =>
      r.registerToolServer({ ...HTTP_SERVER, allowedTools: ['search_issues', 'search_issue'] }),
    )

    const result = await probeToolServer({
      agentKindRegistry: registry,
      workspaceId: 'ws_1',
      serverId: 'issues',
      resolveToolSecrets: resolverFor({ ACME_TRACKER_TOKEN: 'tok' }),
      probe: { fetch: okResponses(['search_issues', 'get_issue']) },
    })

    // The failure no other layer can see: a well-formed name that matches nothing narrows
    // claude-code's allow-list to a dead pattern while the prompt keeps advertising the tool.
    expect(result.allowedTools).toEqual({
      declared: ['search_issues', 'search_issue'],
      unmatched: ['search_issue'],
      checked: true,
    })
  })

  it('withholds the allowedTools verdict when the tool list was truncated', async () => {
    const registry = registryWith((r) =>
      r.registerToolServer({ ...HTTP_SERVER, allowedTools: ['get_issue'] }),
    )

    const result = await probeToolServer({
      agentKindRegistry: registry,
      workspaceId: 'ws_1',
      serverId: 'issues',
      resolveToolSecrets: resolverFor({ ACME_TRACKER_TOKEN: 'tok' }),
      // A cursor still outstanding at the page bound.
      probe: { fetch: okResponses(['search_issues'], 'more'), maxPages: 1 },
    })

    // `get_issue` is absent from what came back and that is NOT evidence it is absent from the
    // server, so reporting it as unmatched would send an operator to edit a correct declaration.
    expect(result).toMatchObject({
      toolsComplete: false,
      allowedTools: { declared: ['get_issue'], unmatched: [], checked: false },
    })
  })

  it('reports a required credential this board has not stored, without sending a request', async () => {
    const registry = registryWith((r) => r.registerToolServer(HTTP_SERVER))
    const doFetch = (async () => {
      throw new Error('the probe must not reach the network with no credential')
    }) as unknown as typeof fetch

    const result = await probeToolServer({
      agentKindRegistry: registry,
      workspaceId: 'ws_1',
      serverId: 'issues',
      resolveToolSecrets: resolverFor({}),
      probe: { fetch: doFetch },
    })

    // Naming the KEY is what lets the surface point at the checklist row that needs a value.
    // Sending the request without it would answer 401 and report the credential as WRONG.
    expect(result).toEqual({
      serverId: 'issues',
      status: 'credentials_missing',
      unresolvedCredentials: ['ACME_TRACKER_TOKEN'],
    })
  })

  it('refuses a credential whose lookup key names a platform variable, and says so', async () => {
    const logger = createRecordingLogger()
    const registry = registryWith((r) =>
      r.registerToolServer({
        ...HTTP_SERVER,
        secretKeys: [{ key: 'ENCRYPTION_KEY', header: 'Authorization' }],
      }),
    )
    const doFetch = (async () => {
      throw new Error('the probe must not resolve a reserved key')
    }) as unknown as typeof fetch

    const result = await probeToolServer({
      agentKindRegistry: registry,
      workspaceId: 'ws_1',
      serverId: 'issues',
      // A resolver that WOULD answer it, so the refusal is the floor holding rather than the
      // resolver declining.
      resolveToolSecrets: resolverFor({ ENCRYPTION_KEY: 'master' }),
      logger,
      probe: { fetch: doFetch },
    })

    // Its own status, kept apart from `credentials_missing`: setting the variable is precisely what
    // must not help, so the DECLARATION is the fix.
    expect(result).toEqual({
      serverId: 'issues',
      status: 'credential_refused',
      refusedCredentials: ['ENCRYPTION_KEY'],
    })
    expect(logger.lines.some((line) => line.msg.includes('reserved credential key'))).toBe(true)
  })

  it('refuses a stdio server by name rather than pretending to reach it', async () => {
    const registry = registryWith((r) => r.registerToolServer(STDIO_SERVER))

    expect(
      await probeToolServer({
        agentKindRegistry: registry,
        workspaceId: 'ws_1',
        serverId: 'advisories',
      }),
    ).toEqual({
      serverId: 'advisories',
      status: 'not_probeable',
      notProbeableReason: 'stdio_transport',
    })
  })

  it('refuses a loopback url, where a SUCCESS would be the misleading answer', async () => {
    const registry = registryWith((r) =>
      r.registerToolServer({
        id: 'sidecar',
        transport: { kind: 'http', url: 'http://localhost:9/rpc' },
      }),
    )

    expect(
      await probeToolServer({
        agentKindRegistry: registry,
        workspaceId: 'ws_1',
        serverId: 'sidecar',
      }),
    ).toMatchObject({ status: 'not_probeable', notProbeableReason: 'container_local_url' })
  })

  it('resolves an INLINE definition, which is reachable only through the kind that declares it', async () => {
    const registry = registryWith((r) =>
      r.register({
        kind: 'auditor',
        systemPrompt: 'p',
        toolServers: [{ ...HTTP_SERVER, secretKeys: [] }],
      }),
    )

    expect(
      await probeToolServer({
        agentKindRegistry: registry,
        workspaceId: 'ws_1',
        serverId: 'issues',
        probe: { fetch: okResponses(['search_issues', 'get_issue']) },
      }),
    ).toMatchObject({ status: 'ok' })
  })

  it('probes the SAME definition the inventory row describes when one id has two', async () => {
    // A registration and a kind's INLINE declaration may carry one id. The row and the verdict then
    // have to be about the same server, or the operator reads a url, a credential list and a tool
    // narrowing from one definition and a verdict produced against another, both labelled `issues`.
    // Pinned by driving both halves off one registry and comparing the url actually requested.
    const registry = registryWith((r) => {
      r.registerToolServer({
        ...HTTP_SERVER,
        transport: { kind: 'http', url: 'https://registered.example/rpc' },
      })
      r.register({
        kind: 'auditor',
        systemPrompt: 'p',
        toolServers: [
          {
            ...HTTP_SERVER,
            secretKeys: [],
            transport: { kind: 'http', url: 'https://inline.example/rpc' },
          },
        ],
      })
    })
    const requested: string[] = []
    const inner = okResponses(['search_issues', 'get_issue'])
    const doFetch = (async (url: string, init?: RequestInit) => {
      requested.push(String(url))
      return (inner as unknown as (u: string, i?: RequestInit) => Promise<Response>)(url, init)
    }) as unknown as typeof fetch

    const [view] = collectDeclaredToolServers({ agentKindRegistry: registry })
    const result = await probeToolServer({
      agentKindRegistry: registry,
      workspaceId: 'ws_1',
      serverId: 'issues',
      probe: { fetch: doFetch },
    })

    expect(result).toMatchObject({ status: 'ok' })
    expect(new URL(requested[0]!).origin).toBe(new URL(view!.target).origin)
  })

  it('404s an id this deployment declares nowhere', async () => {
    await expect(
      probeToolServer({
        agentKindRegistry: new AgentKindRegistry(),
        workspaceId: 'ws_1',
        serverId: 'ghost',
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

/**
 * A compliant server's three responses (initialize, the notification's 202, tools/list), shared by
 * the OAuth cases below — the probe describe keeps its own copy scoped to its page-bound tests.
 */
function okResponsesForOAuth(): typeof fetch {
  let call = 0
  return (async () => {
    call++
    if (call === 1) {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            serverInfo: { name: 'linear-mcp', version: '1.0.0' },
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    }
    if (call === 2) return new Response(null, { status: 202 })
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'list_issues' }] } }),
      { headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch
}

// The OAuth half of both surfaces: what a probe answers for a server nobody has granted, and what
// the connect/disconnect routes refuse before a browser ever leaves the app.
describe('probeToolServer with OAuth', () => {
  const OAUTH_SERVER: McpServerDefinition = {
    id: 'linear',
    transport: { kind: 'http', url: 'https://mcp.linear.app/mcp' },
    oauth: { grant: 'authorization_code', clientId: 'cid' },
  }
  const neverFetch = (async () => {
    throw new Error('the probe must not reach the network without a token')
  }) as unknown as typeof fetch

  it('reports an ungranted server as oauth_not_connected rather than probing it unauthenticated', async () => {
    const result = await probeToolServer({
      agentKindRegistry: registryWith((r) => r.registerToolServer(OAUTH_SERVER)),
      workspaceId: 'ws_1',
      serverId: 'linear',
      resolveToolServerOAuth: { accessToken: async () => ({ status: 'not_connected' }) },
      probe: { fetch: neverFetch },
    })
    // Probing anyway and reporting the 401 would say "your credential is wrong", which is the one
    // diagnosis that is false here: there is no credential to be wrong.
    expect(result).toEqual({ serverId: 'linear', status: 'oauth_not_connected' })
  })

  it('keeps a failed token exchange apart, and carries the cause', async () => {
    const result = await probeToolServer({
      agentKindRegistry: registryWith((r) => r.registerToolServer(OAUTH_SERVER)),
      workspaceId: 'ws_1',
      serverId: 'linear',
      resolveToolServerOAuth: {
        accessToken: async () => ({ status: 'token_failed', error: 'invalid_grant' }),
      },
      probe: { fetch: neverFetch },
    })
    expect(result).toMatchObject({ status: 'oauth_token_failed', error: 'invalid_grant' })
  })

  it('sends the granted token as the header the declaration named', async () => {
    const sent: Record<string, string>[] = []
    const inner = okResponsesForOAuth()
    const result = await probeToolServer({
      agentKindRegistry: registryWith((r) => r.registerToolServer(OAUTH_SERVER)),
      workspaceId: 'ws_1',
      serverId: 'linear',
      resolveToolServerOAuth: {
        accessToken: async () => ({
          status: 'ok',
          header: 'Authorization',
          value: 'Bearer granted',
        }),
      },
      probe: {
        fetch: (async (url: string, init?: RequestInit) => {
          sent.push(Object.fromEntries(new Headers(init?.headers).entries()))
          return inner(url, init)
        }) as unknown as typeof fetch,
      },
    })
    expect(result.status).toBe('ok')
    expect(sent[0]!.authorization).toBe('Bearer granted')
  })

  it('reports the server as unconnected when the deployment has no grant store at all', async () => {
    const result = await probeToolServer({
      agentKindRegistry: registryWith((r) => r.registerToolServer(OAUTH_SERVER)),
      workspaceId: 'ws_1',
      serverId: 'linear',
      probe: { fetch: neverFetch },
    })
    expect(result.status).toBe('oauth_not_connected')
  })
})

describe('toolServerController', () => {
  function build(container: Partial<ServerContainer>): Hono<AppEnv> {
    const app = new Hono<AppEnv>()
    app.onError(handleError)
    app.use('*', async (c, next) => {
      c.set('container', container as ServerContainer)
      await next()
    })
    app.route('/workspaces/:workspaceId', toolServerController())
    return app
  }

  it('answers the inventory off the registry the engine dispatches from', async () => {
    const agentKindRegistry = registryWith((r) => {
      r.registerToolServer(HTTP_SERVER)
      r.assignToolServers('coder', ['issues'])
    })

    const res = await build({ agentKindRegistry }).request('/workspaces/ws_1/tool-servers')

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ servers: [{ id: 'issues', declaredBy: ['coder'] }] })
  })

  it('reports credentials_missing when the facade composed no chain at all', async () => {
    // The container's resolver is optional (a facade may wire none), and the honest answer is the
    // one the dispatch path gives the same state — never a probe that quietly succeeds against an
    // endpoint it reached unauthenticated.
    const agentKindRegistry = registryWith((r) => r.registerToolServer(HTTP_SERVER))

    const res = await build({ agentKindRegistry }).request(
      '/workspaces/ws_1/tool-servers/issues/test',
      { method: 'POST' },
    )

    expect(await res.json()).toMatchObject({
      status: 'credentials_missing',
      unresolvedCredentials: ['ACME_TRACKER_TOKEN'],
    })
  })

  // The connect/disconnect routes. Every refusal here has to land BEFORE the browser leaves the
  // app: a refusal after the redirect arrives on a vendor's error page, where nothing this
  // deployment wrote is visible.
  describe('oauth routes', () => {
    const OAUTH_SERVER: McpServerDefinition = {
      id: 'linear',
      transport: { kind: 'http', url: 'https://mcp.linear.app/mcp' },
      oauth: { grant: 'authorization_code', clientId: 'cid' },
    }
    const fakeOAuth = (over: Partial<Record<string, unknown>> = {}) =>
      ({
        listStatuses: async () => new Map(),
        startAuthorization: async () => ({ url: 'https://auth.linear.app/authorize?state=x' }),
        disconnect: async () => undefined,
        ...over,
      }) as unknown as ServerContainer['mcpOAuth']

    it('answers the vendor authorization url', async () => {
      const res = await build({
        agentKindRegistry: registryWith((r) => r.registerToolServer(OAUTH_SERVER)),
        mcpOAuth: fakeOAuth(),
        mcpOAuthRedirectUrl: 'https://app.example.com/mcp/oauth/callback',
      }).request('/workspaces/ws_1/tool-servers/linear/oauth/authorize', { method: 'POST' })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ url: 'https://auth.linear.app/authorize?state=x' })
    })

    it('refuses with a 503 naming the variable when no redirect url is registered', async () => {
      const res = await build({
        agentKindRegistry: registryWith((r) => r.registerToolServer(OAUTH_SERVER)),
        mcpOAuth: fakeOAuth(),
      }).request('/workspaces/ws_1/tool-servers/linear/oauth/authorize', { method: 'POST' })

      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({
        error: { details: { reason: 'mcp_oauth_redirect_url_not_configured' } },
      })
    })

    it('refuses a server that authenticates with a static credential', async () => {
      const res = await build({
        agentKindRegistry: registryWith((r) => r.registerToolServer(HTTP_SERVER)),
        mcpOAuth: fakeOAuth(),
        mcpOAuthRedirectUrl: 'https://app.example.com/mcp/oauth/callback',
      }).request('/workspaces/ws_1/tool-servers/issues/oauth/authorize', { method: 'POST' })

      expect(res.status).toBe(422)
      expect(await res.json()).toMatchObject({
        error: { details: { reason: 'tool_server_without_oauth' } },
      })
    })

    it('disconnects an id no live declaration names', async () => {
      // A grant OUTLIVES the declaration that created it (a retired server, a rename in a
      // refactor), and the row is then a live vendor token nobody can reach — so the one action
      // that removes it must not be gated on the registry still naming it.
      let dropped: string[] = []
      const res = await build({
        agentKindRegistry: new AgentKindRegistry(),
        mcpOAuth: fakeOAuth({
          disconnect: async (_ws: string, id: string) => {
            dropped.push(id)
          },
        }),
      }).request('/workspaces/ws_1/tool-servers/retired/oauth', { method: 'DELETE' })

      expect(res.status).toBe(204)
      expect(dropped).toEqual(['retired'])
    })

    it('projects a stored grant onto the inventory row', async () => {
      const res = await build({
        agentKindRegistry: registryWith((r) => r.registerToolServer(OAUTH_SERVER)),
        mcpOAuth: fakeOAuth({
          listStatuses: async () =>
            new Map([['linear', { connectedBy: 'usr_1', refreshable: true }]]),
        }),
      }).request('/workspaces/ws_1/tool-servers')

      expect(await res.json()).toMatchObject({
        servers: [
          {
            id: 'linear',
            oauth: {
              grant: 'authorization_code',
              connected: true,
              connectedBy: 'usr_1',
              refreshable: true,
            },
          },
        ],
      })
    })

    it('renders a declaration as unconnected when the deployment has no grant store', async () => {
      const res = await build({
        agentKindRegistry: registryWith((r) => r.registerToolServer(OAUTH_SERVER)),
      }).request('/workspaces/ws_1/tool-servers')

      expect(await res.json()).toMatchObject({
        servers: [{ id: 'linear', oauth: { connected: false } }],
      })
    })
  })

  it('refuses its OWN routes to a member without secrets.manage, and no sibling controller’s', async () => {
    // The regression this pins is a Hono scoping trap, not an authorization judgement.
    // `app.route('/workspaces/:workspaceId', sub)` re-registers each of `sub`'s entries under that
    // prefix, so a `sub.use('*', gate)` becomes `ALL /workspaces/:workspaceId/*` on the SHARED app
    // and matches every sibling controller's routes as well. Hono runs whichever matching entry was
    // registered first, so the blast radius depends on the order in `app.ts`.
    //
    // For a writes-only gate that stayed invisible: the siblings it could reach are admin-tier
    // anyway. Gating READS made it an outage — `GET /workspaces/:ws/github/repos`, which a plain
    // member may read, started answering 403. Hence the mount on `/tool-servers` + `/tool-servers/*`
    // (both, because Hono's `*` does not match the bare prefix), asserted here against the WORST
    // ordering: this controller registered first, the sibling after it.
    const app = new Hono<AppEnv>()
    app.onError(handleError)
    app.use('*', async (c, next) => {
      c.set('container', {
        agentKindRegistry: new AgentKindRegistry(),
      } as unknown as ServerContainer)
      // A plain member: signed in, sees the board, holds none of the admin permissions. Both are
      // needed — `requirePermission` treats "no user AND no access" as dev-open and allows all.
      c.set('user', { id: 'u_1' } as never)
      c.set('workspaceAccess', { allowed: true, role: 'member', permissions: new Set() } as never)
      await next()
    })
    app.route('/workspaces/:workspaceId', toolServerController())
    const sibling = new Hono<AppEnv>()
    sibling.get('/github/repos', (c) => c.json({ repos: [] }, 200))
    app.route('/workspaces/:workspaceId', sibling)

    expect((await app.request('/workspaces/ws_1/tool-servers')).status).toBe(403)
    expect(
      (await app.request('/workspaces/ws_1/tool-servers/issues/test', { method: 'POST' })).status,
    ).toBe(403)
    expect((await app.request('/workspaces/ws_1/github/repos')).status).toBe(200)
  })
})
