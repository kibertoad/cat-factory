import { isAllowedMcpHttpUrl, redactSecrets } from '@cat-factory/kernel'
import { MCP_PROBE_MAX_PAGES, MCP_PROBE_TIMEOUT_MS } from '@cat-factory/contracts'
import {
  chooseProtocolVersion,
  dialectHeaders,
  LEGACY_ERA,
  legacyInitializeParams,
  MODERN_ERA,
  readDiscoverResult,
  readEraVerdict,
  readModernServerInfo,
  requestParams,
  type McpEra,
  type ServerIdentity,
  isRecord,
} from './mcpDialect.js'

// ---------------------------------------------------------------------------
// A minimal Streamable-HTTP MCP CLIENT, for one purpose: ask a declared `http` tool server whether
// it is there. Open in the modern (stateless) dialect, fall back to the legacy handshake when
// nothing modern answers, then `tools/list` until the pages run out.
//
// DUAL-ERA, because both revisions are live: `2026-07-28` deleted `initialize`,
// `notifications/initialized` and the session header, and the spec's own matrix rates a legacy
// client against a modern server as "Fails" with no fall-forward. The two dialects and the rule
// that tells a modern refusal from a legacy one live in `mcpDialect.ts`; this file owns the
// transport.
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
//     exactly as the local-runner fetch does) — and, when the request carries a credential, held to
//     the SAME ORIGIN as well. That is not extra caution beyond what a real client does, it is what
//     a real client does: the Web platform REMOVES `Authorization` when a redirect crosses origins
//     (fetch's CORS non-wildcard request-header rule), so an agent's own MCP client reaches such a
//     hop unauthenticated. Forwarding a resolved credential there would make the probe the one path
//     that hands a workspace's token to whatever a hijacked or expired vendor host redirects to,
//     and it would answer about a request no run will ever make. Refused BY NAME instead, because
//     "your declared url redirects off its origin" is the fix, where a silently credential-less
//     401 is a wrong cause.
//   - a POST on every hop, deliberately NOT the spec's 301/302/303 method rewrite. A GET to an MCP
//     endpoint means "open the SSE stream", so degrading to one asks a different question.
//
// It never throws. Every failure is a discriminated outcome, because the whole point is to hand the
// operator a CAUSE, and "the probe blew up" is not one.
// ---------------------------------------------------------------------------

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
  /** The non-secret headers the DECLARATION itself carries (`transport.headers`). */
  headers: Record<string, string>
  /**
   * The resolved credential headers. Never logged, never returned.
   *
   * Kept APART from `headers` rather than merged by the caller, because the two are treated
   * differently at a redirect: a hop that leaves the declared origin is refused while these are
   * present, and a declaration's own `x-tenant` is not a reason to refuse anything.
   */
  credentialHeaders: Record<string, string>
}

export interface McpProbeDeps {
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch
  timeoutMs?: number
  maxPages?: number
}

interface McpProbeSuccess {
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

type McpProbeFailure =
  | { status: 'unreachable'; error: string }
  | { status: 'http_error'; httpStatus: number; error: string }
  | { status: 'protocol_error'; error: string }

export type McpProbeOutcome = McpProbeSuccess | McpProbeFailure

/**
 * One JSON-RPC exchange's result: the `result` object, or the reason there wasn't one.
 *
 * A failure carries the parsed `frame` when the body held one, plus the status it arrived with,
 * because a modern server states WHICH refusal this is in a JSON-RPC error body served under a 400.
 * Reading the era off the rendered prose instead would be parsing our own error message.
 */
type ExchangeOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; failure: McpProbeFailure; frame?: Record<string, unknown> }

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
  // ONE deadline for the whole exchange rather than a timeout per request. Three round trips each
  // allowed the full budget is three times the wait an operator was told to expect, and the thing
  // being bounded is how long this endpoint holds a request open.
  const timeoutMs = deps.timeoutMs ?? MCP_PROBE_TIMEOUT_MS
  const ctx: Exchange = {
    doFetch: deps.fetch ?? fetch,
    target,
    session: new SessionHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
    timeoutMs,
    // Opened MODERN. The era is a property of the SERVER, not of a request, so it is decided once
    // and then held for every later call: a `tools/list` sent in a dialect the discovery did not
    // establish is the header-mismatch the spec answers with `-32020`.
    era: MODERN_ERA,
  }

  const outcome = await handshakeAndList(ctx, deps.maxPages ?? MCP_PROBE_MAX_PAGES)
  // A session the server minted is ENDED before answering, whatever the outcome was. The spec's own
  // termination path, and without it every press of the Test button leaves a session on the server
  // to expire on its own clock. Best effort by construction: it cannot change the verdict, so a
  // server that refuses or ignores the DELETE costs nothing.
  await endSession(ctx)
  return outcome
}

/** The exchange itself: settle the era, then read every page of `tools/list` in that dialect. */
async function handshakeAndList(ctx: Exchange, maxPages: number): Promise<McpProbeOutcome> {
  const opened = await openServer(ctx)
  if ('failure' in opened) return opened.failure

  const listed = await listTools(ctx, maxPages)
  if (!listed.ok) return listed.failure
  // A modern server identifies itself in EVERY result's `_meta`, so a `server/discover` that named
  // nothing is not the last chance to learn who answered.
  const identity = opened.identity ?? listed.identity ?? { serverName: '', serverVersion: '' }
  return {
    status: 'ok',
    ...identity,
    protocolVersion: opened.protocolVersion,
    tools: listed.tools,
    toolsComplete: listed.complete,
  }
}

/** What settling the era established: which revision is being spoken, and who said so. */
interface OpenedServer {
  protocolVersion: string
  identity?: ServerIdentity
}

/**
 * Decide which era this server speaks, leaving `ctx.era` set to it.
 *
 * Modern first, because that is the direction the spec gives for Streamable HTTP and the only one
 * that reaches a server which has dropped `initialize`. One version retry is allowed, for the
 * server that names a revision we also speak; beyond that a refusal is either reported (a modern
 * server said no on grounds we control) or answered by the legacy handshake.
 */
async function openServer(ctx: Exchange): Promise<OpenedServer | { failure: McpProbeFailure }> {
  const first = await discover(ctx)
  if (first.kind !== 'retry') return settle(ctx, first)
  ctx.era = { era: 'modern', version: first.version }
  return settle(ctx, await discover(ctx))
}

async function settle(
  ctx: Exchange,
  attempt: DiscoverAttempt,
): Promise<OpenedServer | { failure: McpProbeFailure }> {
  switch (attempt.kind) {
    case 'modern':
      return {
        protocolVersion: ctx.era.era === 'modern' ? ctx.era.version : '',
        ...(attempt.identity ? { identity: attempt.identity } : {}),
      }
    case 'legacy':
      return legacyHandshake(ctx)
    case 'retry':
      // A second `UnsupportedProtocolVersionError` after retrying the version the server itself
      // named. Reported rather than retried again: the server is contradicting its own answer.
      return {
        failure: {
          status: 'protocol_error',
          error: `the server refused MCP ${attempt.version} after naming it as supported`,
        },
      }
    case 'failure':
      return { failure: attempt.failure }
  }
}

type DiscoverAttempt =
  | { kind: 'modern'; identity?: ServerIdentity }
  | { kind: 'retry'; version: string }
  | { kind: 'legacy' }
  | { kind: 'failure'; failure: McpProbeFailure }

/**
 * Ask the modern `server/discover`, which every modern server MUST implement.
 *
 * Its answer is also the era test: a result carrying `supportedVersions` is proof of a modern
 * server, one of the three MCP-reserved error codes is proof of a modern server refusing, and
 * anything else (a `-32601`, an un-parseable 400, a 405) means nothing modern is there.
 */
async function discover(ctx: Exchange): Promise<DiscoverAttempt> {
  const answer = await exchange(ctx, { id: 1, method: 'server/discover' })
  if (answer.ok) {
    const discovered = readDiscoverResult(answer.result)
    // A 200 result that is not a `DiscoverResult` is not evidence of anything modern: an unrelated
    // JSON-RPC endpoint answers that way too. Fall through to the legacy attempt, whose own
    // refusal is what names "answering JSON-RPC but not MCP".
    if (!discovered) return { kind: 'legacy' }
    return adoptDiscoveredVersion(ctx, discovered)
  }
  // The STATUS decides before the body does. `readFrame` parses a JSON body under ANY non-2xx, so
  // an auth proxy answering `{"error":"invalid_token"}` at 401 hands back a frame that reads as
  // "not modern" and buys a second, identically refused handshake. A refused redirect, an
  // unreadable body, a 401 and a 5xx are facts about the ENDPOINT rather than about a dialect, and
  // asking again in the other one spends the deadline twice for the same answer. Only the statuses
  // a server really answers an unknown or unsupported request with reach the era reader.
  const httpStatus = answer.failure.status === 'http_error' ? answer.failure.httpStatus : undefined
  if (httpStatus !== undefined && !LEGACY_FALLBACK_STATUSES.has(httpStatus)) {
    return { kind: 'failure', failure: answer.failure }
  }
  // The server spoke JSON-RPC, so its error code says which era answered: one of the three
  // MCP-reserved codes is a modern server refusing, and anything else (`-32601`, "not
  // initialized") is a server that never knew the method.
  if (answer.frame) {
    const verdict = readEraVerdict(answer.frame)
    if (verdict.verdict === 'retry') return { kind: 'retry', version: verdict.version }
    if (verdict.verdict === 'report') {
      return {
        kind: 'failure',
        failure: { status: 'protocol_error', error: redact(verdict.error) },
      }
    }
    return { kind: 'legacy' }
  }
  // A fallback status with no readable frame is the spec's own trigger: the endpoint did not
  // understand a modern request, so ask the handshake. Anything else is the endpoint's own fault,
  // already stated.
  if (httpStatus !== undefined) return { kind: 'legacy' }
  return { kind: 'failure', failure: answer.failure }
}

/**
 * Settle which revision the rest of the exchange speaks, given the list `server/discover` named.
 *
 * `supportedVersions` is what the modern revision publishes the RPC for, so reading it and then
 * sending the next request under the version we happened to open with makes the probe report a
 * revision the server never agreed to, and leaves `tools/list` to be refused by a server that
 * already said which revision to use. Reconciling is the same rule the `-32022` refusal takes, so
 * both go through `chooseProtocolVersion` and cannot drift apart.
 */
function adoptDiscoveredVersion(
  ctx: Exchange,
  discovered: { supportedVersions: string[]; identity?: ServerIdentity },
): DiscoverAttempt {
  const asked = ctx.era.era === 'modern' ? ctx.era.version : undefined
  const choice = chooseProtocolVersion(discovered.supportedVersions, asked)
  // A server whose own discover result names only handshake-era revisions is answering the modern
  // RPC while telling us it does not speak the modern dialect. Take it at its word.
  if (choice.choice === 'legacy') return { kind: 'legacy' }
  if (choice.choice === 'mismatch') {
    return {
      kind: 'failure',
      failure: { status: 'protocol_error', error: redact(choice.error) },
    }
  }
  ctx.era = { era: 'modern', version: choice.version }
  return { kind: 'modern', ...(discovered.identity ? { identity: discovered.identity } : {}) }
}

/**
 * The statuses that mean "this endpoint did not understand a modern request", as opposed to "this
 * endpoint refused you". 400 is the spec's own fallback trigger; 404 and 405 are what an endpoint
 * hosting only the deprecated shapes answers a POST of an unknown method with.
 */
const LEGACY_FALLBACK_STATUSES = new Set([400, 404, 405, 501])

/** The pre-`2026-07-28` opening: `initialize`, then the notification a strict server demands. */
async function legacyHandshake(
  ctx: Exchange,
): Promise<OpenedServer | { failure: McpProbeFailure }> {
  ctx.era = LEGACY_ERA
  const handshake = await exchange(ctx, {
    id: 1,
    method: 'initialize',
    params: legacyInitializeParams(),
  })
  if (!handshake.ok) return { failure: handshake.failure }

  const negotiated = readHandshake(handshake.result)
  if (!negotiated) {
    return {
      failure: {
        status: 'protocol_error',
        error:
          'the endpoint answered neither a modern server/discover nor a handshake carrying a ' +
          'protocolVersion and serverInfo, so it is answering JSON-RPC but is not an MCP server',
      },
    }
  }
  ctx.session.protocolVersion = negotiated.protocolVersion

  // The legacy spec REQUIRES this notification before any other request, and a strict server
  // rejects `tools/list` without it. It carries no id and expects no body (a `202` is the normal
  // answer), so its outcome is only interesting when the transport itself failed.
  const notified = await notify(ctx, 'notifications/initialized')
  if (notified) return { failure: notified }
  return {
    protocolVersion: negotiated.protocolVersion,
    identity: { serverName: negotiated.serverName, serverVersion: negotiated.serverVersion },
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
  /** The dialect every request is shaped in. Settled by {@link openServer}, then held. */
  era: McpEra
}

/**
 * The per-session headers a LEGACY Streamable-HTTP client must echo once it has them.
 *
 * A class rather than two locals because both are minted by the FIRST response and must reach every
 * later request; threading them by hand is exactly how a session-keeping server ends up 400ing the
 * request after the handshake with nothing naming why.
 *
 * Dead weight in the modern era on purpose: `2026-07-28` removed protocol-level sessions, and a
 * server on it MUST NOT mint one. So nothing here is applied while the exchange is modern, and a
 * dual-era server that echoes a session id at a modern request has it ignored rather than adopted.
 */
class SessionHeaders {
  sessionId?: string
  protocolVersion?: string
  /**
   * The url the session was minted at, which a redirect may have moved off the declared one. The
   * DELETE that ends the session has to reach the endpoint that owns it, not the url we asked for.
   */
  endpoint?: string

  apply(headers: Record<string, string>): void {
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId
    if (this.protocolVersion) headers['mcp-protocol-version'] = this.protocolVersion
  }

  adopt(response: Response, url: string): void {
    const minted = response.headers.get('mcp-session-id')
    if (!minted) return
    this.sessionId = minted
    this.endpoint = url
  }
}

/** Read every page of `tools/list`, up to `maxPages`. */
async function listTools(
  exchangeCtx: Exchange,
  maxPages: number,
): Promise<
  | { ok: true; tools: string[]; complete: boolean; identity?: ServerIdentity }
  | { ok: false; failure: McpProbeFailure }
> {
  const tools: string[] = []
  let identity: ServerIdentity | undefined
  let cursor: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const answer = await exchange(exchangeCtx, {
      id: page + 2,
      method: 'tools/list',
      ...(cursor ? { params: { cursor } } : {}),
    })
    if (!answer.ok) return { ok: false, failure: answer.failure }
    identity ??= readModernServerInfo(answer.result)
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
    if (!cursor) return { ok: true, tools, complete: true, ...(identity ? { identity } : {}) }
  }
  // A cursor survived the page bound: the list is a PREFIX, and saying so is what stops the caller
  // reporting a narrowed `allowedTools` entry as missing on the strength of a partial read.
  return { ok: true, tools, complete: false, ...(identity ? { identity } : {}) }
}

/** One JSON-RPC REQUEST and its response. */
async function exchange(
  ctx: Exchange,
  message: { id: number; method: string; params?: Record<string, unknown> },
): Promise<ExchangeOutcome> {
  const params = requestParams(ctx.era, message.params)
  const sent = await post(
    ctx,
    { jsonrpc: '2.0', id: message.id, method: message.method, ...(params ? { params } : {}) },
    message.method,
  )
  if (!sent.ok) return { ok: false, failure: sent.failure }
  const body = await readFrame(ctx, sent.response)
  if (!body.ok) {
    return { ok: false, failure: body.failure, ...(body.frame ? { frame: body.frame } : {}) }
  }
  const frame = body.frame
  if (isRecord(frame.error)) {
    const detail = typeof frame.error.message === 'string' ? frame.error.message : 'no message'
    return {
      ok: false,
      frame,
      failure: {
        status: 'protocol_error',
        error: `${message.method} was refused by the server: ${redact(detail)}`,
      },
    }
  }
  if (!isRecord(frame.result)) {
    return {
      ok: false,
      frame,
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
  const sent = await post(ctx, { jsonrpc: '2.0', method }, method)
  if (!sent.ok) return sent.failure
  // Drain rather than parse: an unread body on a keep-alive connection is a leaked stream on Node,
  // and there is nothing in it this cares about.
  // silent-catch-ok: cancelling a body we never read has no failure worth a line, and this module
  // holds no logger on purpose (it is a pure protocol client the caller reports for).
  await sent.response.body?.cancel().catch(() => {})
  return undefined
}

/**
 * End the session the server minted, if it minted one. The spec's own termination path.
 *
 * Best effort in the strict sense: it runs AFTER the verdict is decided and cannot change it, so
 * every failure is dropped here rather than reported. A server may answer `405` (termination not
 * allowed) and be entirely correct, the deadline may already have passed, and neither is news. What
 * it buys is that pressing Test repeatedly does not leave a session per press on the server to age
 * out on its own clock.
 */
async function endSession(ctx: Exchange): Promise<void> {
  const { sessionId, endpoint } = ctx.session
  if (!sessionId || !endpoint) return
  try {
    const response = await ctx.doFetch(endpoint, {
      method: 'DELETE',
      headers: requestHeaders(ctx, null),
      redirect: 'manual',
      signal: ctx.signal,
    })
    // silent-catch-ok: as above — a body we never read, on a request whose outcome is already
    // irrelevant to the caller.
    await response.body?.cancel().catch(() => {})
  } catch {
    // Nothing to report and nowhere to report it: the verdict is already computed, and a failed
    // courtesy DELETE says nothing about the server an operator asked about.
  }
}

/** POST one frame, following redirects by hand and turning transport faults into outcomes. */
async function post(
  ctx: Exchange,
  frame: Record<string, unknown>,
  method: string,
): Promise<{ ok: true; response: Response } | { ok: false; failure: McpProbeFailure }> {
  let url = ctx.target.url
  const carriesCredential = Object.keys(ctx.target.credentialHeaders).length > 0
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const sent = await send(ctx, url, frame, method)
    if (!sent.ok) return sent
    if (ctx.era.era === 'legacy') ctx.session.adopt(sent.response, url)
    if (!isRedirect(sent.response)) return sent
    const hopTo = nextHop(ctx, url, sent.response, carriesCredential)
    if (!hopTo.ok) return hopTo
    url = hopTo.url
  }
  return {
    ok: false,
    failure: {
      status: 'protocol_error',
      error: `the endpoint redirected more than ${MAX_REDIRECTS} times`,
    },
  }
}

/** One request, with every transport fault turned into an outcome rather than a throw. */
async function send(
  ctx: Exchange,
  url: string,
  frame: Record<string, unknown>,
  method: string,
): Promise<{ ok: true; response: Response } | { ok: false; failure: McpProbeFailure }> {
  try {
    return {
      ok: true,
      response: await ctx.doFetch(url, {
        method: 'POST',
        headers: requestHeaders(ctx, method),
        body: JSON.stringify(frame),
        redirect: 'manual',
        signal: ctx.signal,
      }),
    }
  } catch (error) {
    // Everything that never produced a status: DNS, TLS, connection refused, and the deadline. One
    // outcome for all of them because they share a fix (the endpoint, or the network) and the prose
    // carries which — while a 4xx/5xx is a DIFFERENT fix and gets its own member.
    return {
      ok: false,
      failure: { status: 'unreachable', error: redact(errorText(error, ctx.timeoutMs)) },
    }
  }
}

/**
 * The headers one request carries: the declaration's own, the resolved credential, the session pair,
 * and this client's content negotiation.
 *
 * Lower-cased before the probe's own values are written, which is load-bearing rather than tidy:
 * `Headers` APPENDS as it fills from a record, so a declaration spelling `Accept` plus this
 * function's `accept` arrives at the server as ONE combined value, and a stream-first server then
 * negotiates against something neither side offered.
 */
function requestHeaders(ctx: Exchange, method: string | null): Record<string, string> {
  const headers = lowerCasedKeys({ ...ctx.target.headers, ...ctx.target.credentialHeaders })
  headers['content-type'] = 'application/json'
  headers.accept = 'application/json, text/event-stream'
  if (ctx.era.era === 'legacy') ctx.session.apply(headers)
  // `null` is the session DELETE, which mirrors no JSON-RPC method because it carries no body.
  return method === null ? headers : { ...headers, ...dialectHeaders(ctx.era, method) }
}

function lowerCasedKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value
  return out
}

/** Where a redirect points, or the reason the probe will not follow it. */
function nextHop(
  ctx: Exchange,
  from: string,
  response: Response,
  carriesCredential: boolean,
): { ok: true; url: string } | { ok: false; failure: McpProbeFailure } {
  const location = response.headers.get('location')
  const next = location ? resolveHop(from, location) : undefined
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
          `reached at (https, or plain http on loopback)`,
      },
    }
  }
  // A credential-bearing request stops at its own ORIGIN, matching the Web platform rather than
  // exceeding it: fetch removes `Authorization` when a redirect crosses origins, so the agent's own
  // MCP client reaches this hop unauthenticated and a probe that forwarded the token would both
  // answer about a request no run makes and hand a workspace's credential to whatever the redirect
  // names. Refused rather than followed credential-less, because the FIX is the declaration naming
  // the final url, and a 401 from a stripped hop would name the token instead.
  if (carriesCredential && !sameOrigin(ctx.target.url, next)) {
    return {
      ok: false,
      failure: {
        status: 'protocol_error',
        error:
          `the endpoint redirected to ${redact(next)}, a different origin from the declared url, ` +
          `and the request carries a credential — declare the final url, because an agent's own ` +
          `MCP client reaches a cross-origin hop with the credential removed`,
      },
    }
  }
  return { ok: true, url: next }
}

function isRedirect(response: Response): boolean {
  return response.status >= 300 && response.status < 400
}

/**
 * Whether two urls share an origin. An UNPARSEABLE url is never same-origin with anything, so the
 * caller's refusal is what an unreadable hop reaches rather than a comparison of two undefineds.
 */
function sameOrigin(a: string, b: string): boolean {
  const left = originOf(a)
  return left !== undefined && left === originOf(b)
}

function originOf(raw: string): string | undefined {
  try {
    return new URL(raw).origin
  } catch {
    return undefined
  }
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
  ctx: Exchange,
  response: Response,
): Promise<
  | { ok: true; frame: Record<string, unknown> }
  | { ok: false; failure: McpProbeFailure; frame?: Record<string, unknown> }
> {
  if (!response.ok) {
    const body = await bodyText(response)
    // A modern server states its refusal as a JSON-RPC error UNDER the 4xx (an unsupported version,
    // a header mismatch), so the body is parsed as well as previewed. The verdict stays
    // `http_error` either way: the era reader takes the frame, and everything else takes the status.
    const frame = body ? parseFrame(body) : undefined
    return {
      ok: false,
      ...(frame ? { frame } : {}),
      failure: {
        status: 'http_error',
        httpStatus: response.status,
        // PREVIEWED, like every other quoted body: an auth proxy or a load balancer answers a 4xx
        // with an HTML page, and this string is both rendered in a browser and logged. The status is
        // the diagnosis; the body is a hint about which proxy answered.
        error: redact(
          body ? `HTTP ${response.status}: ${preview(body)}` : `HTTP ${response.status}`,
        ),
      },
    }
  }
  const contentType = response.headers.get('content-type') ?? ''
  const raw = contentType.includes('text/event-stream')
    ? await firstSseData(response)
    : await bodyText(response)
  // An EMPTY body counts as unreadable rather than as JSON that fails to parse, so the prose names
  // the missing body instead of quoting nothing.
  if (raw === undefined || !raw.trim()) {
    return {
      ok: false,
      failure: bodyFailure(ctx, 'the endpoint answered 200 with no readable body'),
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      ok: false,
      failure: bodyFailure(
        ctx,
        `the endpoint answered 200 with a body that is not JSON: ${redact(preview(raw))}`,
      ),
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

/**
 * The failure to report for a body that yielded no frame.
 *
 * The DEADLINE is checked FIRST, because the one signal aborts the response stream as well as the
 * request: a server that answers 200 and then stalls (an SSE stream that never completes an event, a
 * body that stops mid-way) leaves a partial buffer behind, and calling that a `protocol_error` tells
 * the operator "the url names something else" for what is a slow endpoint — the exact cause
 * `unreachable` is documented to cover. A cause is the whole product here, so the two are kept
 * apart even though the code reaches them through the same branch.
 */
function bodyFailure(ctx: Exchange, protocolError: string): McpProbeFailure {
  if (ctx.signal.aborted) return { status: 'unreachable', error: timeoutText(ctx.timeoutMs) }
  return { status: 'protocol_error', error: protocolError }
}

/** A whole body as text, bounded, or undefined when there was no body to read at all. */
async function bodyText(response: Response): Promise<string | undefined> {
  const stream = response.body
  if (!stream) {
    // A bodyless response is legitimate for a notification and a protocol fault for a request; the
    // caller distinguishes, so this stays apart from an EMPTY body, which read fine and said nothing.
    return undefined
  }
  return readBounded(stream, () => false)
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
  return extractSseData(
    await readBounded(stream, (buffered) => extractSseData(buffered) !== undefined),
  )
}

/**
 * Read `stream` until `done(buffered)` says enough arrived, the stream ends, or the character ceiling
 * is hit. Cancels what it did not read, so a stream held open costs no connection past this point.
 *
 * Always a string, never undefined: a read that failed part-way still returns what arrived, and
 * whether that is usable is the caller's question (`bodyFailure` turns an empty one into the right
 * cause, deadline included).
 */
async function readBounded(
  stream: ReadableStream<Uint8Array>,
  done: (buffered: string) => boolean,
): Promise<string> {
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
  // Flush the decoder's pending bytes, so a multi-byte character split across the LAST chunk lands
  // in the buffer (as itself, or as the replacement character a truncated sequence deserves) rather
  // than being dropped silently.
  return buffered + decoder.decode()
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

/** A body as a JSON-RPC frame, or undefined when it is neither JSON nor an object. */
function parseFrame(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    const frame = Array.isArray(parsed) ? parsed[0] : parsed
    return isRecord(frame) ? frame : undefined
  } catch {
    return undefined
  }
}

/** A thrown value as prose. `AbortSignal.timeout` rejects with a bare `TimeoutError`, so name it. */
function errorText(error: unknown, timeoutMs: number): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError'
      ? timeoutText(timeoutMs)
      : `${error.name}: ${error.message}`
  }
  return String(error)
}

/**
 * The deadline in prose, authored ONCE: the same expiry is reachable as a rejected request and as an
 * aborted body read, and two spellings of one cause read like two causes.
 */
function timeoutText(timeoutMs: number): string {
  return `the endpoint did not answer within ${timeoutMs / 1000}s`
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
