import { isAllowedMcpHttpUrl, redactSecrets } from '@cat-factory/kernel'
import { MCP_PROBE_MAX_PAGES, MCP_PROBE_TIMEOUT_MS } from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// A minimal Streamable-HTTP MCP CLIENT, for one purpose: ask a declared `http` tool server whether
// it is there. `initialize`, `notifications/initialized`, then `tools/list` until the pages run out.
//
// Hand-rolled over `fetch` rather than built on `@modelcontextprotocol/sdk`'s client, and the reason
// is the one slice 3 already recorded about the SERVING side: the backend's HTTP layer is typed
// against the Web platform alone so it cannot break on workerd, and the SDK's client transport
// carries an OAuth provider, a reconnecting SSE stream, resumption tokens and a zod-validated
// message layer — every one of which this needs to NOT do. Three POSTs and a JSON reader is smaller
// than the adapter that would hold that machinery back, and it keeps the SDK out of a module every
// facade bundles.
//
// What it deliberately keeps from the real client, because a probe that behaves differently from the
// agent's own CLI answers about the wrong thing:
//
//   - `accept: application/json, text/event-stream` and a reader for BOTH. A stateless server
//     answers with JSON; a stream-first one answers the same frame as one SSE event. A client that
//     accepted only JSON would report a working server as a protocol error.
//   - the `mcp-session-id` a server may mint on `initialize`, echoed on every later request, and the
//     negotiated `mcp-protocol-version` beside it. Without them a session-keeping server answers
//     the handshake and then 400s the `tools/list` that follows.
//   - redirects, followed by hand up to {@link MAX_REDIRECTS} hops with every hop re-validated
//     against `isAllowedMcpHttpUrl` (the same rule the declared url is held to, re-checked per hop
//     exactly as the local-runner fetch does). The credential headers ride along, because the
//     agent's own MCP client would follow the hop with them too: a probe that stripped them would
//     report a 401 for a server that works on a run, which is a worse answer than the redirect.
//
// It never throws. Every failure is a discriminated outcome, because the whole point is to hand the
// operator a CAUSE, and "the probe blew up" is not one.
// ---------------------------------------------------------------------------

/**
 * The protocol version the probe asks for.
 *
 * A literal rather than a read of the SDK's `LATEST_PROTOCOL_VERSION`, and drift is benign by the
 * protocol's own design: negotiation belongs to the SERVER, which answers with the requested version
 * when it speaks it and with one of its own when it does not. So a probe advertising something older
 * than the spec's latest still completes a handshake with a newer server, and the version this
 * reports is always the one the server chose rather than the one we asked for.
 */
const PROBE_PROTOCOL_VERSION = '2025-11-25'

/** Redirect hops one probe follows. Bounded because a redirect loop is the server's to author. */
const MAX_REDIRECTS = 3

/**
 * Bytes read from one response before the reader gives up.
 *
 * An SSE body has no length and a server decides when it ends, so a reader with no ceiling hands a
 * remote server the ability to hold this request open until the timeout with a stream of padding.
 * Sized well past any real `tools/list` page (the biggest tool tables in the wild are tens of KB).
 */
const MAX_RESPONSE_BYTES = 4_000_000

export interface McpProbeTarget {
  url: string
  /** Request headers, INCLUDING the resolved credential header. Never logged, never returned. */
  headers: Record<string, string>
}

export interface McpProbeDeps {
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch
  timeoutMs?: number
  maxPages?: number
}

export interface McpProbeSuccess {
  status: 'ok'
  serverName: string
  serverVersion: string
  /** The version the SERVER negotiated, which is what the agent's CLI will speak to it. */
  protocolVersion: string
  /** Every tool name read, uncapped — the caller caps what reaches the wire. */
  tools: string[]
  /** False when a `nextCursor` was still outstanding at {@link MCP_PROBE_MAX_PAGES}. */
  toolsComplete: boolean
}

export type McpProbeFailure =
  | { status: 'unreachable'; error: string }
  | { status: 'http_error'; httpStatus: number; error: string }
  | { status: 'protocol_error'; error: string }

export type McpProbeOutcome = McpProbeSuccess | McpProbeFailure

/** One JSON-RPC exchange's result: the `result` object, or the reason there wasn't one. */
type ExchangeOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; failure: McpProbeFailure }

/**
 * Speak MCP to `target` and report what happened.
 *
 * The caller owns the DECISION to probe at all (a stdio server has no url; a loopback one is not
 * ours to reach) and the credential resolution that fills `headers`. This owns only the protocol.
 */
export async function probeMcpHttpServer(
  target: McpProbeTarget,
  deps: McpProbeDeps = {},
): Promise<McpProbeOutcome> {
  const doFetch = deps.fetch ?? fetch
  const maxPages = deps.maxPages ?? MCP_PROBE_MAX_PAGES
  // ONE deadline for the whole exchange rather than a timeout per request. Three round trips each
  // allowed the full budget is three times the wait an operator was told to expect, and the thing
  // being bounded is how long this endpoint holds a request open.
  const timeoutMs = deps.timeoutMs ?? MCP_PROBE_TIMEOUT_MS
  const signal = AbortSignal.timeout(timeoutMs)
  const session = new SessionHeaders()

  const handshake = await exchange(
    { doFetch, target, session, signal, timeoutMs },
    { id: 1, method: 'initialize', params: initializeParams() },
  )
  if (!handshake.ok) return handshake.failure

  const negotiated = readHandshake(handshake.result)
  if (!negotiated) {
    return {
      status: 'protocol_error',
      error:
        'the endpoint answered the handshake without a protocolVersion or serverInfo, so it is ' +
        'answering JSON-RPC but is not an MCP server',
    }
  }
  session.protocolVersion = negotiated.protocolVersion

  // The spec REQUIRES this notification before any other request, and a strict server rejects
  // `tools/list` without it. It carries no id and expects no body (a `202` is the normal answer), so
  // its outcome is only interesting when the transport itself failed.
  const notified = await notify(
    { doFetch, target, session, signal, timeoutMs },
    'notifications/initialized',
  )
  if (notified) return notified

  const listed = await listTools({ doFetch, target, session, signal, timeoutMs }, maxPages)
  if (!listed.ok) return listed.failure
  return { status: 'ok', ...negotiated, tools: listed.tools, toolsComplete: listed.complete }
}

/**
 * What the probe says it is.
 *
 * `capabilities: {}` is honest and load-bearing: this client implements no roots, no sampling and no
 * elicitation, and a server that saw a capability declared here could legitimately try to use it
 * mid-handshake. `tools/list` needs none of them.
 */
function initializeParams(): Record<string, unknown> {
  return {
    protocolVersion: PROBE_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'cat-factory-tool-server-probe', version: '1' },
  }
}

/** The negotiated handshake facts, or undefined when the answer was not an MCP one. */
function readHandshake(
  result: Record<string, unknown>,
): { protocolVersion: string; serverName: string; serverVersion: string } | undefined {
  const protocolVersion = typeof result.protocolVersion === 'string' ? result.protocolVersion : ''
  const info = isRecord(result.serverInfo) ? result.serverInfo : undefined
  if (!protocolVersion || !info) return undefined
  return {
    protocolVersion,
    serverName: typeof info.name === 'string' ? info.name : '',
    // A server that omits its version is odd, not broken: the field is what the surface renders
    // beside the name, so an empty string there beats refusing an otherwise complete handshake.
    serverVersion: typeof info.version === 'string' ? info.version : '',
  }
}

interface Exchange {
  doFetch: typeof fetch
  target: McpProbeTarget
  session: SessionHeaders
  signal: AbortSignal
  /** The deadline actually applied, so the prose names it rather than the default. */
  timeoutMs: number
}

/**
 * The per-session headers a Streamable-HTTP client must echo once it has them.
 *
 * A class rather than two locals because both are minted by the FIRST response and must reach every
 * later request; threading them by hand is exactly how a session-keeping server ends up 400ing the
 * request after the handshake with nothing naming why.
 */
class SessionHeaders {
  sessionId?: string
  protocolVersion?: string

  apply(headers: Record<string, string>): void {
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId
    if (this.protocolVersion) headers['mcp-protocol-version'] = this.protocolVersion
  }

  adopt(response: Response): void {
    const minted = response.headers.get('mcp-session-id')
    if (minted) this.sessionId = minted
  }
}

/** Read every page of `tools/list`, up to `maxPages`. */
async function listTools(
  exchangeCtx: Exchange,
  maxPages: number,
): Promise<
  { ok: true; tools: string[]; complete: boolean } | { ok: false; failure: McpProbeFailure }
> {
  const tools: string[] = []
  let cursor: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const answer = await exchange(exchangeCtx, {
      id: page + 2,
      method: 'tools/list',
      ...(cursor ? { params: { cursor } } : {}),
    })
    if (!answer.ok) return { ok: false, failure: answer.failure }
    const listed = answer.result.tools
    if (!Array.isArray(listed)) {
      return {
        ok: false,
        failure: {
          status: 'protocol_error',
          error: 'the server answered tools/list without a tools array',
        },
      }
    }
    for (const tool of listed) {
      if (isRecord(tool) && typeof tool.name === 'string' && tool.name) tools.push(tool.name)
    }
    const next = answer.result.nextCursor
    cursor = typeof next === 'string' && next ? next : undefined
    if (!cursor) return { ok: true, tools, complete: true }
  }
  // A cursor survived the page bound: the list is a PREFIX, and saying so is what stops the caller
  // reporting a narrowed `allowedTools` entry as missing on the strength of a partial read.
  return { ok: true, tools, complete: false }
}

/** One JSON-RPC REQUEST and its response. */
async function exchange(
  ctx: Exchange,
  message: { id: number; method: string; params?: Record<string, unknown> },
): Promise<ExchangeOutcome> {
  const sent = await post(ctx, { jsonrpc: '2.0', ...message })
  if (!sent.ok) return { ok: false, failure: sent.failure }
  const body = await readFrame(sent.response)
  if (!body.ok) return { ok: false, failure: body.failure }
  const frame = body.frame
  if (isRecord(frame.error)) {
    const detail = typeof frame.error.message === 'string' ? frame.error.message : 'no message'
    return {
      ok: false,
      failure: {
        status: 'protocol_error',
        error: `${message.method} was refused by the server: ${redact(detail)}`,
      },
    }
  }
  if (!isRecord(frame.result)) {
    return {
      ok: false,
      failure: {
        status: 'protocol_error',
        error: `${message.method} answered without a JSON-RPC result object`,
      },
    }
  }
  return { ok: true, result: frame.result }
}

/**
 * One JSON-RPC NOTIFICATION. Returns a failure only when the transport itself did — a notification
 * has no response to inspect, and a server that answers it with a body is within its rights.
 */
async function notify(ctx: Exchange, method: string): Promise<McpProbeFailure | undefined> {
  const sent = await post(ctx, { jsonrpc: '2.0', method })
  if (!sent.ok) return sent.failure
  // Drain rather than parse: an unread body on a keep-alive connection is a leaked stream on Node,
  // and there is nothing in it this cares about.
  // silent-catch-ok: cancelling a body we never read has no failure worth a line, and this module
  // holds no logger on purpose (it is a pure protocol client the caller reports for).
  await sent.response.body?.cancel().catch(() => {})
  return undefined
}

/** POST one frame, following redirects by hand and turning transport faults into outcomes. */
async function post(
  ctx: Exchange,
  frame: Record<string, unknown>,
): Promise<{ ok: true; response: Response } | { ok: false; failure: McpProbeFailure }> {
  let url = ctx.target.url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers: Record<string, string> = {
      ...ctx.target.headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    }
    ctx.session.apply(headers)
    let response: Response
    try {
      response = await ctx.doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(frame),
        redirect: 'manual',
        signal: ctx.signal,
      })
    } catch (error) {
      // Everything that never produced a status: DNS, TLS, connection refused, and the deadline.
      // One outcome for all of them because they share a fix (the endpoint, or the network) and the
      // prose carries which — while a 4xx/5xx below is a DIFFERENT fix and gets its own member.
      return {
        ok: false,
        failure: { status: 'unreachable', error: redact(errorText(error, ctx.timeoutMs)) },
      }
    }
    ctx.session.adopt(response)
    if (!isRedirect(response)) return { ok: true, response }
    const location = response.headers.get('location')
    const next = location ? resolveHop(url, location) : undefined
    if (!next) {
      return {
        ok: false,
        failure: {
          status: 'protocol_error',
          error: `the endpoint answered ${response.status} with no usable Location header`,
        },
      }
    }
    // The hop is held to the SAME rule the declared url is: an https endpoint that redirects a
    // credential-bearing request onto cleartext is the one thing that rule exists to stop, and a
    // redirect is the way a declaration that passed boot validation still gets there.
    if (!isAllowedMcpHttpUrl(next)) {
      return {
        ok: false,
        failure: {
          status: 'protocol_error',
          error:
            `the endpoint redirected to ${redact(next)}, which an MCP tool server may not be ` +
            `reached at (https, or plain http on loopback) — the request carries a credential`,
        },
      }
    }
    url = next
  }
  return {
    ok: false,
    failure: {
      status: 'protocol_error',
      error: `the endpoint redirected more than ${MAX_REDIRECTS} times`,
    },
  }
}

function isRedirect(response: Response): boolean {
  return response.status >= 300 && response.status < 400
}

/** Absolutise a `Location` against the url it came from, or undefined when it is unparseable. */
function resolveHop(from: string, location: string): string | undefined {
  try {
    return new URL(location, from).toString()
  } catch {
    return undefined
  }
}

/**
 * Read one JSON-RPC response frame out of whichever body shape arrived.
 *
 * A non-2xx is settled FIRST and as its own outcome. An MCP server refusing a call answers 200 with
 * a JSON-RPC error, so a status outside 2xx means something other than the MCP layer answered — a
 * gateway, an auth proxy, a wrong path — and reporting it as a protocol error would send the
 * operator to look at the server's tool table instead of at the status.
 */
async function readFrame(
  response: Response,
): Promise<{ ok: true; frame: Record<string, unknown> } | { ok: false; failure: McpProbeFailure }> {
  if (!response.ok) {
    const body = await bodyText(response)
    return {
      ok: false,
      failure: {
        status: 'http_error',
        httpStatus: response.status,
        error: redact(body ? `HTTP ${response.status}: ${body}` : `HTTP ${response.status}`),
      },
    }
  }
  const contentType = response.headers.get('content-type') ?? ''
  const raw = contentType.includes('text/event-stream')
    ? await firstSseData(response)
    : await bodyText(response)
  if (raw === undefined) {
    return {
      ok: false,
      failure: {
        status: 'protocol_error',
        error: 'the endpoint answered 200 with no readable body',
      },
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      ok: false,
      failure: {
        status: 'protocol_error',
        error: `the endpoint answered 200 with a body that is not JSON: ${redact(preview(raw))}`,
      },
    }
  }
  // A BATCH response is a legal JSON-RPC shape and every request here is single, so a server that
  // wraps its answer in an array is answering the one call we made. Unwrapped rather than refused.
  const frame = Array.isArray(parsed) ? parsed[0] : parsed
  if (!isRecord(frame)) {
    return {
      ok: false,
      failure: {
        status: 'protocol_error',
        error: 'the endpoint answered JSON that is not a frame',
      },
    }
  }
  return { ok: true, frame }
}

/** A whole body as text, bounded, or undefined when it could not be read. */
async function bodyText(response: Response): Promise<string | undefined> {
  const stream = response.body
  if (!stream) {
    // A bodyless response is legitimate for a notification and a protocol fault for a request; the
    // caller distinguishes, so an empty string here is a body that parses to nothing.
    return undefined
  }
  const read = await readBounded(stream, () => false)
  return read
}

/**
 * The first SSE `data:` payload in the stream.
 *
 * Read INCREMENTALLY and stopped at the first complete event rather than draining to the end,
 * because a stream-first server keeps the stream open after answering: `.text()` on it waits for the
 * deadline to close a connection that has already delivered what was asked for.
 */
async function firstSseData(response: Response): Promise<string | undefined> {
  const stream = response.body
  if (!stream) return undefined
  const raw = await readBounded(stream, (buffered) => extractSseData(buffered) !== undefined)
  return raw === undefined ? undefined : extractSseData(raw)
}

/**
 * Read `stream` until `done(buffered)` says enough arrived, the stream ends, or the byte ceiling is
 * hit. Cancels what it did not read, so a stream held open costs no connection past this point.
 */
async function readBounded(
  stream: ReadableStream<Uint8Array>,
  done: (buffered: string) => boolean,
): Promise<string | undefined> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffered += decoder.decode(chunk.value, { stream: true })
      if (buffered.length > MAX_RESPONSE_BYTES || done(buffered)) break
    }
  } catch {
    // A body that failed mid-read: whatever arrived is what the caller gets to parse, and an empty
    // buffer becomes its own "no readable body" outcome above.
  } finally {
    // silent-catch-ok: cancelling a reader that has already ended or errored is the normal path
    // here, and a throw out of `finally` would replace the outcome the caller needs with noise.
    await reader.cancel().catch(() => {})
  }
  return buffered
}

/**
 * The `data:` payload of the first COMPLETE event in an SSE buffer, or undefined while none has
 * arrived yet. An event ends at a blank line, which is what makes "complete" decidable mid-stream;
 * a `data:` line with nothing after it may still be half a payload.
 */
function extractSseData(buffered: string): string | undefined {
  const normalised = buffered.replaceAll('\r\n', '\n')
  const terminator = /\n\n/.exec(normalised)
  if (!terminator) return undefined
  const event = normalised.slice(0, terminator.index)
  // Multi-line `data:` fields concatenate with newlines, per the SSE spec.
  const data = event
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).replace(/^ /, ''))
  return data.length ? data.join('\n') : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A thrown value as prose. `AbortSignal.timeout` rejects with a bare `TimeoutError`, so name it. */
function errorText(error: unknown, timeoutMs: number): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError'
      ? `the endpoint did not answer within ${timeoutMs / 1000}s`
      : `${error.name}: ${error.message}`
  }
  return String(error)
}

/** First line and a bounded prefix, for prose that quotes an unexpected body. */
function preview(raw: string): string {
  const oneLine = raw.replaceAll(/\s+/g, ' ').trim()
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine
}

/**
 * Every string this module returns goes through here.
 *
 * A fetch failure routinely echoes the request url, and this request's url may carry userinfo while
 * its headers carry a resolved credential; a 4xx body from an auth proxy echoes tokens as a matter
 * of routine. The result is rendered in a browser and logged, so the scrub happens at the emit site
 * rather than being left to whoever consumes it.
 */
function redact(text: string): string {
  return redactSecrets(text) ?? ''
}
