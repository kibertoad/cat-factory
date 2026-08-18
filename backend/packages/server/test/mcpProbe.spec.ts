import { describe, expect, it } from 'vitest'
import { probeMcpHttpServer } from '../src/modules/toolServers/mcpProbe.js'

// The hand-rolled Streamable-HTTP client, driven against stub responses.
//
// What these pin is every reason the probe exists to distinguish. The point of the endpoint is that
// an operator gets a CAUSE rather than a boolean, so each of `unreachable` / `http_error` /
// `protocol_error` / `ok` has to be reachable from the shape that really produces it — and the two
// body shapes a compliant server may answer with (JSON, and one SSE event) must both read as `ok`,
// because a client that understood only one would report a working server as broken.
//
// The probe is DUAL-ERA, so every exchange opens with a modern `server/discover`. A test about the
// legacy handshake therefore answers that first request with `legacyRejection()`: a server that
// does not know the method, which is what an unmigrated server really answers.

interface Recorded {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

/**
 * A stub `fetch` that answers each request in turn from `answers`, recording what it was sent.
 *
 * An answer may be a function, which is handed the `RequestInit` so a test can build a response that
 * reacts to the request's SIGNAL. A real fetch errors the response body when the signal aborts, and
 * nothing else in a stub is listening, so a body that models a stalling server has to do it itself.
 */
function stubFetch(
  answers: Array<Response | ((init?: RequestInit) => Response | Promise<Response>)>,
) {
  const sent: Recorded[] = []
  let index = 0
  const doFetch = (async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value
    }
    sent.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    const answer = answers[index++]
    if (!answer) throw new Error(`unexpected request ${index}: ${String(url)}`)
    return typeof answer === 'function' ? await answer(init) : answer
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

/**
 * How a LEGACY server answers the modern `server/discover` that now opens every probe: JSON-RPC's
 * own "method not found", which is deliberately not one of the three MCP-reserved codes that would
 * mark the answer as a modern server's.
 */
function legacyRejection(): Response {
  return json({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } })
}

/** A `server/discover` result: the modern era's proof that an MCP server is there. */
const DISCOVER = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    resultType: 'complete',
    supportedVersions: ['2026-07-28'],
    capabilities: { tools: {} },
    _meta: {
      'io.modelcontextprotocol/serverInfo': { name: 'acme-mcp', version: '4.2.0' },
    },
  },
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

const target = {
  url: 'https://mcp.example/rpc',
  headers: {},
  credentialHeaders: { authorization: 'Bearer tok' },
}

describe('probeMcpHttpServer', () => {
  it('completes the handshake, sends the initialized notification, and lists tools', async () => {
    const { doFetch, sent } = stubFetch([
      legacyRejection(),
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
    // The modern probe first, then the legacy handshake in the order that spec requires, with the
    // notification in the middle. A strict legacy server rejects `tools/list` without it, so its
    // absence would be an intermittent failure against real servers only.
    expect(sent.map((r) => (r.body as { method: string }).method)).toEqual([
      'server/discover',
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

  it('speaks the MODERN dialect to a server that answers server/discover', async () => {
    const { doFetch, sent } = stubFetch([
      json(DISCOVER),
      json({
        jsonrpc: '2.0',
        id: 2,
        result: { resultType: 'complete', tools: [{ name: 'search' }] },
      }),
    ])

    const outcome = await probeMcpHttpServer(target, { fetch: doFetch })

    expect(outcome).toEqual({
      status: 'ok',
      serverName: 'acme-mcp',
      serverVersion: '4.2.0',
      protocolVersion: '2026-07-28',
      tools: ['search'],
      toolsComplete: true,
    })
    // No handshake and no notification: `2026-07-28` deleted both, and sending them to a modern
    // server is the request it answers with `-32601`.
    expect(sent.map((r) => (r.body as { method: string }).method)).toEqual([
      'server/discover',
      'tools/list',
    ])
    for (const request of sent) {
      const body = request.body as { params?: { _meta?: Record<string, unknown> } }
      // Version, identity and capabilities ride EVERY request now, not one handshake…
      expect(body.params?._meta?.['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28')
      expect(body.params?._meta?.['io.modelcontextprotocol/clientInfo']).toBeDefined()
      // …and the header MUST carry the same version and the body's own method, or the server
      // answers `-32020 HeaderMismatch`.
      expect(request.headers['mcp-protocol-version']).toBe('2026-07-28')
      expect(request.headers['mcp-method']).toBe((request.body as { method: string }).method)
      // Sessions are gone from this revision, so the probe must not invent one.
      expect(request.headers['mcp-session-id']).toBeUndefined()
    }
  })

  it('retries at the version a modern server names, rather than falling back', async () => {
    const { doFetch, sent } = stubFetch([
      json(
        {
          jsonrpc: '2.0',
          id: 1,
          error: {
            code: -32022,
            message: 'Unsupported protocol version',
            data: { supported: ['2026-07-28'], requested: '2026-07-28' },
          },
        },
        { status: 400 },
      ),
      json(DISCOVER),
      json({ jsonrpc: '2.0', id: 2, result: { tools: [] } }),
    ])

    const outcome = await probeMcpHttpServer(target, { fetch: doFetch })

    // A modern server refusing a VERSION is still a modern server: the 400 carries an MCP-reserved
    // error code, and the spec's fallback rule is explicitly conditioned on that body.
    expect(outcome).toMatchObject({ status: 'ok', protocolVersion: '2026-07-28' })
    expect(sent).toHaveLength(3)
    expect((sent[1]!.body as { method: string }).method).toBe('server/discover')
  })

  it('reports a version mismatch it cannot bridge instead of retrying forever', async () => {
    const { doFetch, sent } = stubFetch([
      json(
        {
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32022, message: 'nope', data: { supported: ['2030-01-01'] } },
        },
        { status: 400 },
      ),
    ])

    const outcome = await probeMcpHttpServer(target, { fetch: doFetch })

    // Falling back to `initialize` here would ask a server that just listed its revisions for one
    // it did not list, so the mismatch itself is the answer, with both sides named.
    expect(outcome).toMatchObject({ status: 'protocol_error' })
    expect((outcome as { error: string }).error).toContain('2030-01-01')
    expect(sent).toHaveLength(1)
  })

  it('takes the server identity off a modern result when discovery named none', async () => {
    const { doFetch } = stubFetch([
      json({
        jsonrpc: '2.0',
        id: 1,
        result: { resultType: 'complete', supportedVersions: ['2026-07-28'] },
      }),
      json({
        jsonrpc: '2.0',
        id: 2,
        result: {
          tools: [],
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'quiet-mcp', version: '0.1' } },
        },
      }),
    ])

    const outcome = await probeMcpHttpServer(target, { fetch: doFetch })

    // `serverInfo` is only SHOULD-level in the modern revision and rides every result, so a
    // discovery that omitted it is not the last chance to learn who answered.
    expect(outcome).toMatchObject({ status: 'ok', serverName: 'quiet-mcp', serverVersion: '0.1' })
  })

  it('falls back to the handshake when a 400 carries no modern error', async () => {
    const { doFetch, sent } = stubFetch([
      new Response('Bad Request: server not initialized', {
        status: 400,
        headers: { 'content-type': 'text/plain' },
      }),
      json(HANDSHAKE),
      new Response(null, { status: 202 }),
      json({ jsonrpc: '2.0', id: 2, result: { tools: ['a'].map((name) => ({ name })) } }),
    ])

    const outcome = await probeMcpHttpServer(target, { fetch: doFetch })

    // The spec's own trigger: a modern server answers 400 for an unsupported version or a header
    // mismatch, so the BODY decides. This one carries neither, which is a legacy server refusing a
    // request it made no sense of.
    expect(outcome).toMatchObject({ status: 'ok', protocolVersion: '2025-06-18' })
    expect((sent[1]!.body as { method: string }).method).toBe('initialize')
  })

  it('does not re-ask in the other dialect when the endpoint refused the credential', async () => {
    const { doFetch, sent } = stubFetch([
      new Response('unauthorized', { status: 401, headers: { 'content-type': 'text/plain' } }),
    ])

    const outcome = await probeMcpHttpServer(target, { fetch: doFetch })

    // A 401 is about the CREDENTIAL, and asking the same endpoint again in the legacy dialect
    // spends the deadline twice to be told the same thing.
    expect(outcome).toMatchObject({ status: 'http_error', httpStatus: 401 })
    expect(sent).toHaveLength(1)
  })

  it('reads a frame delivered as a single SSE event', async () => {
    const { doFetch } = stubFetch([
      legacyRejection(),
      sse(HANDSHAKE),
      new Response(null, { status: 202 }),
      sse({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'search' }] } }),
    ])

    const outcome = await probeMcpHttpServer(target, { fetch: doFetch })

    expect(outcome).toMatchObject({ status: 'ok', tools: ['search'] })
  })

  it('echoes a minted session id, then ENDS the session it opened', async () => {
    const { doFetch, sent } = stubFetch([
      legacyRejection(),
      json(HANDSHAKE, { headers: { 'content-type': 'application/json', 'mcp-session-id': 's-9' } }),
      new Response(null, { status: 202 }),
      json({ jsonrpc: '2.0', id: 2, result: { tools: [] } }),
      new Response(null, { status: 204 }),
    ])

    const outcome = await probeMcpHttpServer(target, { fetch: doFetch })

    // Without these a session-keeping server answers the handshake and then 400s everything after
    // it, which reads as a broken server rather than a broken client.
    expect(sent[1]!.headers['mcp-session-id']).toBeUndefined()
    expect(sent[2]!.headers['mcp-session-id']).toBe('s-9')
    expect(sent[2]!.headers['mcp-protocol-version']).toBe('2025-06-18')
    expect(sent[3]!.headers['mcp-session-id']).toBe('s-9')
    // The spec's termination path, so pressing Test repeatedly does not leave one session per press
    // on the server to age out on its own clock.
    expect(sent[4]).toMatchObject({ method: 'DELETE', headers: { 'mcp-session-id': 's-9' } })
    expect(outcome).toMatchObject({ status: 'ok' })
  })

  it('does not send a termination for a server that minted no session', async () => {
    const { doFetch, sent } = stubFetch([
      legacyRejection(),
      json(HANDSHAKE),
      new Response(null, { status: 202 }),
      json({ jsonrpc: '2.0', id: 2, result: { tools: [] } }),
    ])

    await probeMcpHttpServer(target, { fetch: doFetch })

    // A stateless server has nothing to terminate, and a DELETE at its endpoint asks it to end a
    // session it never had. Asserted because `stubFetch` would answer a fifth request by throwing,
    // which the probe swallows — so only the count can say the request was never made.
    expect(sent).toHaveLength(4)
  })

  it('keeps its own content negotiation when a declaration spells a header differently', async () => {
    const { doFetch, sent } = stubFetch([
      legacyRejection(),
      json(HANDSHAKE),
      new Response(null, { status: 202 }),
      json({ jsonrpc: '2.0', id: 2, result: { tools: [] } }),
    ])

    await probeMcpHttpServer(
      { ...target, headers: { Accept: 'application/json', 'X-Tenant': 'acme' } },
      { fetch: doFetch },
    )

    // `Headers` APPENDS as it fills from a record, so an un-normalised merge would send
    // `accept: application/json, application/json, text/event-stream` and a stream-first server
    // would negotiate against something neither side offered.
    expect(sent[0]!.headers.accept).toBe('application/json, text/event-stream')
    expect(sent[0]!.headers['x-tenant']).toBe('acme')
  })

  it('follows pagination and reports a list that ran past the page bound as incomplete', async () => {
    const page = (names: string[], nextCursor?: string) =>
      json({
        jsonrpc: '2.0',
        id: 2,
        result: { tools: names.map((name) => ({ name })), ...(nextCursor ? { nextCursor } : {}) },
      })
    const { doFetch, sent } = stubFetch([
      legacyRejection(),
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
    expect((sent[4]!.body as { params: { cursor: string } }).params.cursor).toBe('c1')
  })
})

// The other half of the probe's product: every reason it can fail, told apart. An operator gets a
// CAUSE rather than a boolean, so each of `unreachable` / `http_error` / `protocol_error` has to be
// reachable from the shape that really produces it, and a refusal must not be mistaken for an era.
describe('probeMcpHttpServer failures', () => {
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
    // Answered to BOTH openings: `-32601` to `server/discover` is what sends the probe to the
    // legacy handshake, and the same answer to `initialize` is a server that knows neither.
    const { doFetch } = stubFetch([
      json({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no such method' } }),
      json({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no such method' } }),
    ])

    const outcome = await probeMcpHttpServer(target, { fetch: doFetch })

    expect(outcome).toMatchObject({ status: 'protocol_error' })
    expect((outcome as { error: string }).error).toContain('no such method')
  })

  it('reports a 200 that is neither a discovery nor a handshake as a protocol error', async () => {
    // The realistic shape: the url names a web page or a health endpoint, not this server. It
    // answers both openings the same way, and neither carries what an MCP server must return.
    const { doFetch } = stubFetch([
      json({ jsonrpc: '2.0', id: 1, result: { ok: true } }),
      json({ jsonrpc: '2.0', id: 1, result: { ok: true } }),
    ])

    const outcome = await probeMcpHttpServer(target, { fetch: doFetch })

    expect(outcome).toMatchObject({ status: 'protocol_error' })
    expect((outcome as { error: string }).error).toContain('serverInfo')
  })

  it('follows a SAME-ORIGIN redirect, carrying the credential', async () => {
    const { doFetch, sent } = stubFetch([
      new Response(null, { status: 307, headers: { location: 'https://mcp.example/v2/rpc' } }),
      legacyRejection(),
      json(HANDSHAKE),
      new Response(null, { status: 202 }),
      json({ jsonrpc: '2.0', id: 2, result: { tools: [] } }),
    ])

    const outcome = await probeMcpHttpServer(target, { fetch: doFetch })

    expect(outcome).toMatchObject({ status: 'ok' })
    expect(sent[1]!.url).toBe('https://mcp.example/v2/rpc')
    // A path move inside the declared origin is the ordinary case (a versioned endpoint), and the
    // credential rides it exactly as the agent's own client would.
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
    expect((outcome as { error: string }).error).toContain('may not be')
  })

  it('refuses to carry a credential ACROSS ORIGINS, https or not', async () => {
    const { doFetch, sent } = stubFetch([
      new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/rpc' } }),
    ])

    const outcome = await probeMcpHttpServer(target, { fetch: doFetch })

    // The hop passes the transport rule (it is https), and forwarding the credential anyway would
    // make the probe the one path that hands a workspace's token to whatever a hijacked or expired
    // vendor host redirects to — while answering about a request no run makes, because the Web
    // platform removes `Authorization` on a cross-origin hop. So: refused, with the fix named.
    expect(outcome).toMatchObject({ status: 'protocol_error' })
    expect((outcome as { error: string }).error).toContain('different origin')
    expect(sent).toHaveLength(1)
  })

  it('follows a cross-origin redirect when there is no credential to leak', async () => {
    const { doFetch, sent } = stubFetch([
      new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/rpc' } }),
      legacyRejection(),
      json(HANDSHAKE),
      new Response(null, { status: 202 }),
      json({ jsonrpc: '2.0', id: 2, result: { tools: [] } }),
    ])

    const outcome = await probeMcpHttpServer(
      { url: 'https://mcp.example/rpc', headers: {}, credentialHeaders: {} },
      { fetch: doFetch },
    )

    // The refusal above is about the CREDENTIAL, not about redirects: an unauthenticated server
    // that moves origins is reachable on a run too, so reporting it as broken would be the probe
    // inventing a fault.
    expect(outcome).toMatchObject({ status: 'ok' })
    expect(sent[1]!.url).toBe('https://elsewhere.example/rpc')
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

  it('names the deadline for a stream that stalls AFTER answering 200', async () => {
    // The shape a real slow endpoint has: headers arrive, the body does not. The probe's one signal
    // aborts the response stream as well as the request, so this used to surface as a
    // `protocol_error` — "the url names something else" for a server that is merely slow, and the
    // one cause `unreachable` is documented to cover.
    const { doFetch } = stubFetch([
      (init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              // Never enqueues, never closes: the deadline is what ends it, exactly as a real fetch
              // ends a body whose request was aborted.
              init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    ])

    const outcome = await probeMcpHttpServer(target, { fetch: doFetch, timeoutMs: 60 })

    expect(outcome).toMatchObject({ status: 'unreachable' })
    expect((outcome as { error: string }).error).toContain('did not answer within')
  })

  it('bounds the body it quotes back from a non-2xx answer', async () => {
    // An auth proxy or a load balancer answers a 4xx with an HTML page, and this string is both
    // rendered in a browser and logged. The STATUS is the diagnosis; the body is a hint about who
    // answered, so it is previewed like every other quoted body rather than echoed whole.
    const { doFetch } = stubFetch([
      new Response(`<html>${'x'.repeat(50_000)}</html>`, {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    ])

    const outcome = await probeMcpHttpServer(target, { fetch: doFetch })

    expect(outcome).toMatchObject({ status: 'http_error', httpStatus: 502 })
    expect((outcome as { error: string }).error.length).toBeLessThan(300)
  })

  it('reports an empty 200 as a missing body rather than as unparseable JSON', async () => {
    const { doFetch } = stubFetch([
      new Response('', { status: 200, headers: { 'content-type': 'application/json' } }),
    ])

    const outcome = await probeMcpHttpServer(target, { fetch: doFetch })

    expect(outcome).toMatchObject({ status: 'protocol_error' })
    expect((outcome as { error: string }).error).toContain('no readable body')
  })
})
