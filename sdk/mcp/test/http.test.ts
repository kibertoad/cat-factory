import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { describe, expect, it } from 'vitest'
import { handleMcpHttpRequest, refuseMcpMethod } from '../src/http.ts'

// The hosted endpoint driven by a REAL MCP client over the REAL Streamable HTTP transport, with the
// client's own `fetch` pointed straight at `handleMcpHttpRequest`. No server socket: the handler's
// whole contract is `Request → Response`, so a loopback `fetch` exercises every byte a deployment's
// route would, including the protocol negotiation a hand-built POST would skip.
//
// The layer below (tool table, rendering, filters) is pinned by `server.test.ts` against the same
// in-memory client, so what belongs here is only what the HTTP shape adds.

const ENDPOINT = 'https://cat-factory.test/api/v1/mcp'

/** A `fetch` that answers this endpoint from the handler, and the API calls the tools made. */
function hostedFetch(
  apiReply: (url: string) => Response,
  onTransportError?: (error: Error) => void,
): { fetch: typeof globalThis.fetch; apiCalls: string[] } {
  const apiCalls: string[] = []
  const impl = (async (input: unknown, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    if (request.url.startsWith(ENDPOINT)) {
      return handleMcpHttpRequest(request, {
        baseUrl: 'https://cat-factory.test',
        apiKey: 'cf_live_key.secret',
        // The tools' own calls loop back through this same function, which is exactly how a
        // deployment wires it: the facade reaches its API the way any other caller does.
        fetch: impl,
        ...(onTransportError ? { onTransportError } : {}),
      })
    }
    apiCalls.push(`${request.method} ${request.url}`)
    return apiReply(request.url)
  }) as unknown as typeof globalThis.fetch
  return { fetch: impl, apiCalls }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

async function connect(
  apiReply: (url: string) => Response = () => json({ services: [] }),
): Promise<{ client: Client; apiCalls: string[] }> {
  const { fetch, apiCalls } = hostedFetch(apiReply)
  const client = new Client({ name: 'test-host', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(ENDPOINT), { fetch }))
  return { client, apiCalls }
}

describe('the hosted MCP endpoint', () => {
  it('initializes, lists and calls over Streamable HTTP', async () => {
    const { client, apiCalls } = await connect((url) =>
      url.includes('/services')
        ? json({ services: [{ serviceId: 'blk_svc', name: 'Billing' }] })
        : json({}),
    )
    // Reaching here at all is the assertion for `initialize`: the client throws on a failed
    // negotiation rather than returning one.
    expect(client.getInstructions() ?? '').toContain('cat-factory')

    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toContain('services_list')

    const result = (await client.callTool({ name: 'services_list', arguments: {} })) as {
      structuredContent?: { services?: { serviceId?: string }[] }
    }
    expect(result.structuredContent?.services?.[0]?.serviceId).toBe('blk_svc')
    // The tool reached the API through the injected `fetch`, under the key the mount supplied.
    expect(apiCalls).toEqual(['GET https://cat-factory.test/api/v1/services'])
  })

  it('serves each request from its own server, holding no session', async () => {
    // A stateless endpoint must not mint an `Mcp-Session-Id`: a client that adopted one would send it
    // on the next request, which a different isolate or instance has never heard of. Two requests
    // over one client is the case that catches a server keeping state it cannot promise to keep.
    const { fetch } = hostedFetch(() => json({ services: [] }))
    const initialize = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'x', version: '0' },
        },
      }),
    })
    expect(initialize.status).toBe(200)
    expect(initialize.headers.get('mcp-session-id')).toBeNull()

    // …and a follow-up carrying no session id is answered rather than 400'd, which is what a
    // session-keyed transport would do to it.
    const listed = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    })
    expect(listed.status).toBe(200)
    const body = (await listed.json()) as { result?: { tools?: unknown[] } }
    expect(body.result?.tools?.length).toBeGreaterThan(0)
  })

  it('answers a JSON body rather than an event stream', async () => {
    // The choice a request-scoped runtime forces: nothing here pushes server-initiated messages, so
    // an SSE stream would be a held-open connection delivering one response.
    const { fetch } = hostedFetch(() => json({}))
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    })
    expect(response.headers.get('content-type')).toContain('application/json')
  })

  it('reports a transport fault to the mount instead of dropping it', async () => {
    // A malformed frame is answered by the transport before the mount sees anything, so without this
    // the only trace of "the MCP endpoint is broken" is the client's own console.
    const faults: string[] = []
    const { fetch } = hostedFetch(
      () => json({}),
      (error) => faults.push(error.message),
    )
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{ not json',
    })
    expect(response.status).toBe(400)
    expect(faults.join(' ')).toContain('Parse error')
  })
})

describe('refuseMcpMethod', () => {
  it('admits POST and refuses the stream/session verbs in the protocol shape', async () => {
    expect(refuseMcpMethod('POST')).toBeNull()
    // The spec's own answer for an endpoint that offers no server-to-client stream, so a client
    // reads it as "poll me" rather than as a broken deployment.
    for (const method of ['GET', 'DELETE', 'PUT']) {
      const refusal = refuseMcpMethod(method)
      expect(refusal?.status).toBe(405)
      // A 405 without `Allow` leaves the client to guess which verb it should have used.
      expect(refusal?.headers.get('allow')).toBe('POST')
      const body = (await refusal!.json()) as { jsonrpc?: string; error?: { code?: number } }
      expect(body.jsonrpc).toBe('2.0')
      expect(body.error?.code).toBe(-32000)
    }
  })
})
