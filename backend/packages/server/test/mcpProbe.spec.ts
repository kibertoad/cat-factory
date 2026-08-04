import { describe, expect, it } from 'vitest'
import { probeMcpHttpServer } from '../src/modules/toolServers/mcpProbe.js'

// The hand-rolled Streamable-HTTP client, driven against stub responses.
//
// What these pin is every reason the probe exists to distinguish. The point of the endpoint is that
// an operator gets a CAUSE rather than a boolean, so each of `unreachable` / `http_error` /
// `protocol_error` / `ok` has to be reachable from the shape that really produces it — and the two
// body shapes a compliant server may answer with (JSON, and one SSE event) must both read as `ok`,
// because a client that understood only one would report a working server as broken.

interface Recorded {
  url: string
  headers: Record<string, string>
  body: unknown
}

/** A stub `fetch` that answers each POST in turn from `answers`, recording what it was sent. */
function stubFetch(answers: Array<Response | (() => Response | Promise<Response>)>) {
  const sent: Recorded[] = []
  let index = 0
  const doFetch = (async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value
    }
    sent.push({
      url: String(url),
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    const answer = answers[index++]
    if (!answer) throw new Error(`unexpected request ${index}: ${String(url)}`)
    return typeof answer === 'function' ? await answer() : answer
  }) as unknown as typeof fetch
  return { doFetch, sent }
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

/** One JSON-RPC frame delivered the way a stream-first server delivers it. */
function sse(body: unknown): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const HANDSHAKE = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    protocolVersion: '2025-06-18',
    capabilities: { tools: {} },
    serverInfo: { name: 'acme-mcp', version: '4.2.0' },
  },
}

const target = { url: 'https://mcp.example/rpc', headers: { authorization: 'Bearer tok' } }

describe('probeMcpHttpServer', () => {
  it('completes the handshake, sends the initialized notification, and lists tools', async () => {
    const { doFetch, sent } = stubFetch([
      json(HANDSHAKE),
      new Response(null, { status: 202 }),
      json({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'search' }, { name: 'post' }] } }),
    ])

    const outcome = await probeMcpHttpServer(target, { fetch: doFetch })

    expect(outcome).toEqual({
      status: 'ok',
      serverName: 'acme-mcp',
      serverVersion: '4.2.0',
      // The version the SERVER chose, not the one the probe asked for — which is what the agent's
      // own CLI will end up speaking to it.
      protocolVersion: '2025-06-18',
      tools: ['search', 'post'],
      toolsComplete: true,
    })
    // Three POSTs in the order the spec requires, the notification in the middle. A strict server
    // rejects `tools/list` without it, so its absence would be an intermittent failure against
    // real servers only.
    expect(sent.map((r) => (r.body as { method: string }).method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
    ])
    // The credential rides every request, and both content negotiation headers are present: a
    // client that accepted only JSON would read a stream-first server as a protocol error.
    for (const request of sent) {
      expect(request.headers.authorization).toBe('Bearer tok')
      expect(request.headers.accept).toBe('application/json, text/event-stream')
    }
  })

  it('reads a frame delivered as a single SSE event', async () => {
    const { doFetch } = stubFetch([
      sse(HANDSHAKE),
      new Response(null, { status: 202 }),
      sse({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'search' }] } }),
    ])

    const outcome = await probeMcpHttpServer(target, { fetch: doFetch })

    expect(outcome).toMatchObject({ status: 'ok', tools: ['search'] })
  })

  it('echoes a minted session id and the negotiated protocol version on later requests', async () => {
    const { doFetch, sent } = stubFetch([
      json(HANDSHAKE, { headers: { 'content-type': 'application/json', 'mcp-session-id': 's-9' } }),
      new Response(null, { status: 202 }),
      json({ jsonrpc: '2.0', id: 2, result: { tools: [] } }),
    ])

    await probeMcpHttpServer(target, { fetch: doFetch })

    // Without these a session-keeping server answers the handshake and then 400s everything after
    // it, which reads as a broken server rather than a broken client.
    expect(sent[0]!.headers['mcp-session-id']).toBeUndefined()
    expect(sent[1]!.headers['mcp-session-id']).toBe('s-9')
    expect(sent[1]!.headers['mcp-protocol-version']).toBe('2025-06-18')
    expect(sent[2]!.headers['mcp-session-id']).toBe('s-9')
  })

  it('follows pagination and reports a list that ran past the page bound as incomplete', async () => {
    const page = (names: string[], nextCursor?: string) =>
      json({
        jsonrpc: '2.0',
        id: 2,
        result: { tools: names.map((name) => ({ name })), ...(nextCursor ? { nextCursor } : {}) },
      })
    const { doFetch, sent } = stubFetch([
      json(HANDSHAKE),
      new Response(null, { status: 202 }),
      page(['a'], 'c1'),
      page(['b'], 'c2'),
      page(['c'], 'c3'),
    ])

    const outcome = await probeMcpHttpServer(target, { fetch: doFetch, maxPages: 3 })

    // Every name read is returned, and `toolsComplete: false` is what stops the caller reporting a
    // narrowed `allowedTools` entry as missing on the strength of a prefix.
    expect(outcome).toMatchObject({ status: 'ok', tools: ['a', 'b', 'c'], toolsComplete: false })
    expect((sent[3]!.body as { params: { cursor: string } }).params.cursor).toBe('c1')
  })

  it('reports a transport failure as unreachable, distinct from a status', async () => {
    const { doFetch } = stubFetch([
      () => {
        throw new TypeError('fetch failed')
      },
    ])

    const outcome = await probeMcpHttpServer(target, { fetch: doFetch })

    expect(outcome).toEqual({ status: 'unreachable', error: 'TypeError: fetch failed' })
  })

  it('reports a non-2xx as http_error carrying the status', async () => {
    const { doFetch } = stubFetch([
      new Response('unauthorized', { status: 401, headers: { 'content-type': 'text/plain' } }),
    ])

    const outcome = await probeMcpHttpServer(target, { fetch: doFetch })

    // 401 is the credential being WRONG, which needs a different fix from the credential being
    // absent — hence its own member, with the status attached so the surface can say which.
    expect(outcome).toMatchObject({ status: 'http_error', httpStatus: 401 })
  })

  it('reports a JSON-RPC error frame as a protocol error', async () => {
    const { doFetch } = stubFetch([
      json({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no such method' } }),
    ])

    const outcome = await probeMcpHttpServer(target, { fetch: doFetch })

    expect(outcome).toMatchObject({ status: 'protocol_error' })
    expect((outcome as { error: string }).error).toContain('no such method')
  })

  it('reports a 200 that is not an MCP handshake as a protocol error', async () => {
    // The realistic shape: the url names a web page or a health endpoint, not this server.
    const { doFetch } = stubFetch([json({ jsonrpc: '2.0', id: 1, result: { ok: true } })])

    const outcome = await probeMcpHttpServer(target, { fetch: doFetch })

    expect(outcome).toMatchObject({ status: 'protocol_error' })
    expect((outcome as { error: string }).error).toContain('serverInfo')
  })

  it('follows a redirect within the transport rule, carrying the credential', async () => {
    const { doFetch, sent } = stubFetch([
      new Response(null, { status: 307, headers: { location: 'https://mcp.example/v2/rpc' } }),
      json(HANDSHAKE),
      new Response(null, { status: 202 }),
      json({ jsonrpc: '2.0', id: 2, result: { tools: [] } }),
    ])

    const outcome = await probeMcpHttpServer(target, { fetch: doFetch })

    expect(outcome).toMatchObject({ status: 'ok' })
    expect(sent[1]!.url).toBe('https://mcp.example/v2/rpc')
    // The agent's own MCP client would follow the hop with the credential too, so a probe that
    // stripped it would report a 401 for a server that works on a run.
    expect(sent[1]!.headers.authorization).toBe('Bearer tok')
  })

  it('refuses a redirect onto cleartext rather than following it', async () => {
    const { doFetch } = stubFetch([
      new Response(null, { status: 302, headers: { location: 'http://mcp.example/rpc' } }),
    ])

    const outcome = await probeMcpHttpServer(target, { fetch: doFetch })

    // The whole reason `isAllowedMcpHttpUrl` exists is that the request carries a credential
    // header, and a redirect is how a declaration that passed boot validation still reaches
    // cleartext.
    expect(outcome).toMatchObject({ status: 'protocol_error' })
    expect((outcome as { error: string }).error).toContain('carries a credential')
  })

  it('names the deadline rather than reporting a bare abort', async () => {
    const { doFetch } = stubFetch([
      () => {
        const error = new Error('timed out')
        error.name = 'TimeoutError'
        throw error
      },
    ])

    const outcome = await probeMcpHttpServer(target, { fetch: doFetch, timeoutMs: 4000 })

    expect(outcome).toMatchObject({ status: 'unreachable' })
    expect((outcome as { error: string }).error).toContain('did not answer within')
  })
})
