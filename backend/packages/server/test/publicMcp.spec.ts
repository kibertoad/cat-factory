import type { PublicApiKeyService } from '@cat-factory/integrations'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { handleError } from '../src/http/errorHandler.js'
import { appLoopback } from '../src/http/loopback.js'
import { publicMcpController } from '../src/modules/publicApi/PublicMcpController.js'

// The hosted MCP endpoint's own decisions, driven without a database.
//
// The facades' mounting of it — and the tool calls reaching real rows — is pinned cross-runtime by
// `integration-public-mcp.ts`; the protocol layer is pinned in `sdk/mcp` against a real MCP client.
// What is only visible HERE is the controller's four judgements: the refusal shapes (a domain
// envelope for auth, the transport's own JSON-RPC frame for a method), the scope→tool-list mapping,
// and that the loopback carries the CALLER's key onto the API call rather than the deployment's.
//
// The loopback is real (`appLoopback` over the same app), with a stub `/api/v1` route standing in
// for `PublicApiController` — so this exercises the wiring rather than a hand-made `fetch`.

const KEYS: Record<string, { scope: 'read' | 'write' | 'admin'; workspaceId: string }> = {
  'reader.secret': { scope: 'read', workspaceId: 'ws_1' },
  'writer.secret': { scope: 'write', workspaceId: 'ws_1' },
}

/** A key service that resolves the table above and nothing else. */
function keyService(): PublicApiKeyService {
  return {
    authenticate: async (raw?: string) => {
      const found = raw ? KEYS[raw] : undefined
      return found
        ? { keyId: 'key_1', accountId: 'acc_1', workspaceId: found.workspaceId, scope: found.scope }
        : null
    },
  } as unknown as PublicApiKeyService
}

interface Built {
  app: Hono<AppEnv>
  /** Every `Authorization` header the stub API route saw, in order. */
  seenAuth: string[]
}

function build(options: { unconfigured?: boolean } = {}): Built {
  const app = new Hono<AppEnv>()
  const seenAuth: string[] = []
  const container = (options.unconfigured
    ? {}
    : { publicApiKeys: keyService() }) as unknown as ServerContainer
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })
  // Stands in for `PublicApiController`'s services route: enough to prove the loopback arrives here,
  // carrying the caller's own credential.
  app.get('/api/v1/services', (c) => {
    seenAuth.push(c.req.header('authorization') ?? '(none)')
    return c.json({ services: [{ serviceId: 'blk_svc', name: 'Billing', taskCount: 0 }] })
  })
  app.route('/', publicMcpController(appLoopback(app)))
  app.onError(handleError)
  return { app, seenAuth }
}

const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
}

/** What a JSON-RPC reply can carry, loosely enough that each test reads the half it asserts on. */
interface RpcReply {
  result?: {
    isError?: boolean
    instructions?: string
    tools?: { name: string }[]
    structuredContent?: { services: { serviceId: string }[] }
    content?: { text?: string }[]
  }
  error?: { code: string; message: string; details?: Record<string, unknown> }
}

async function rpc(
  app: Hono<AppEnv>,
  key: string | null,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ status: number; body: RpcReply }> {
  const response = await app.fetch(
    new Request('https://cat-factory.test/api/v1/mcp', {
      method: 'POST',
      headers: { ...MCP_HEADERS, ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
    }),
  )
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

const INIT = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'spec', version: '0' },
}

describe('the hosted MCP endpoint', () => {
  it('refuses an absent or unknown key in the deployment’s error envelope', async () => {
    const { app } = build()
    for (const key of [null, 'nope.nope']) {
      const refused = await rpc(app, key, 'tools/list')
      expect(refused.status).toBe(401)
      // The envelope rather than a JSON-RPC frame, because an auth failure is HTTP-level in the MCP
      // spec and `details.reason` is what tells an operator WHICH failure this was.
      expect(refused.body.error?.code).toBe('unauthorized')
      expect(refused.body.error?.details?.reason).toBe('invalid_api_key')
    }
  })

  it('says the public API is unconfigured rather than 401-ing every caller', async () => {
    // A deployment with no key store cannot authenticate anyone, and reporting that as "your key is
    // wrong" sends the caller to rotate a credential that was never the problem.
    const { app } = build({ unconfigured: true })
    const refused = await rpc(app, 'reader.secret', 'tools/list')
    expect(refused.status).toBe(503)
    expect(refused.body.error?.details?.reason).toBe('public_api_unconfigured')
  })

  it('carries the caller’s own key onto the API call the tool makes', async () => {
    const { app, seenAuth } = build()
    await rpc(app, 'writer.secret', 'initialize', INIT)
    const called = await rpc(app, 'writer.secret', 'tools/call', {
      name: 'services_list',
      arguments: {},
    })
    expect(called.body.result?.isError).toBeFalsy()
    expect(called.body.result?.structuredContent?.services[0]?.serviceId).toBe('blk_svc')
    // The property that keeps the endpoint from being a privilege escalation: the loopback
    // authenticates as whoever called, so every scope and workspace rule applies unchanged.
    expect(seenAuth).toEqual(['Bearer writer.secret'])
  })

  it('narrows the tool list to the reading half for a read-scoped key', async () => {
    const { app } = build()
    const init = await rpc(app, 'reader.secret', 'initialize', INIT)
    // The cause is named, because the fix (mint a wider key) is not the one an operator's read-only
    // switch would need.
    expect(init.body.result?.instructions).toContain('READ-scoped')
    const listed = await rpc(app, 'reader.secret', 'tools/list')
    const tools = listed.body.result?.tools ?? []
    expect(tools.map((tool) => tool.name)).toContain('services_list')
    expect(tools.map((tool) => tool.name)).not.toContain('tasks_create')

    // …and a write key sees both halves, so the narrowing above is the scope rather than the endpoint.
    const wide = await rpc(app, 'writer.secret', 'tools/list')
    expect((wide.body.result?.tools ?? []).map((tool) => tool.name)).toContain('tasks_create')
  })

  it('refuses the stream and session verbs in the transport’s own shape', async () => {
    const { app } = build()
    for (const method of ['GET', 'DELETE']) {
      const response = await app.fetch(
        new Request('https://cat-factory.test/api/v1/mcp', {
          method,
          headers: { authorization: 'Bearer reader.secret' },
        }),
      )
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('POST')
      // The method refusal comes BEFORE the key check on purpose: it is a fact about the endpoint
      // rather than about the caller, and answering 401 first would have a client with a bad key
      // conclude the URL supports GET.
      expect(((await response.json()) as { jsonrpc?: string }).jsonrpc).toBe('2.0')
    }
  })
})
