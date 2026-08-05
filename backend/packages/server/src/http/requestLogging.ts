import type { Context, Hono } from 'hono'
import type { Logger } from '@cat-factory/kernel'
import {
  SPAN_ID_FIELD,
  TRACEPARENT_HEADER,
  TRACE_ID_FIELD,
  parseTraceparent,
} from '@cat-factory/kernel'
import type { AppEnv } from './env.js'
import { logger } from '../observability/logger.js'

// Request-scoped correlation, shared by every facade. Mounted OUTERMOST (before CORS and
// before the per-request container), so every response — including a CORS denial and the
// misconfiguration fallback — carries an id and produces one log line.
//
// Two things exist here that nothing else in the backend could provide:
//   1. An id a user can read off a failed request and an operator can grep for. Before this,
//      a user report ("it 409'd around 14:20") had nothing to join against: `errorHandler`
//      logged ONLY unexpected 500s, so every 4xx — validation, RBAC denial, conflict — left
//      no server-side trace at all.
//   2. A request-scoped child logger. Anything logging inside a request binds `requestId`,
//      `method` and `path` for free rather than re-spreading them per call site.

/**
 * The propagation header, matching the de-facto convention (and Hono's own `requestId`
 * middleware). A client — a load balancer, another service, the SPA retrying — may supply
 * one; we adopt it when it is safe and mint one otherwise.
 */
export const REQUEST_ID_HEADER = 'X-Request-Id'

/**
 * The longest client-supplied id we will adopt. A header is attacker-controlled on a public
 * deployment and this value is echoed into every log line for the request, so an unbounded
 * one is a log-flooding lever.
 */
const MAX_REQUEST_ID_LENGTH = 255

/** Word characters, `-` and `=` only — enough for a UUID, a ULID or a base64url trace id. */
const SAFE_REQUEST_ID = /^[\w\-=]+$/

/**
 * Paths whose SUCCESSFUL requests log at `debug` rather than `info`. An orchestrator probes
 * liveness/readiness every few seconds, and per-poll lines are exactly what the level table in
 * `backend/docs/logging.md` says `info` is not for — they would bury the request stream in a
 * healthy deployment. A probe that FAILS still logs at its normal level, which is the only time
 * anyone wants to see one.
 *
 * The LLM proxy (`llmProxyController`, mounted on this same app) is the deployment's highest-volume
 * route — one request per model call, so hundreds per coding run — and is DELIBERATELY not quieted.
 * The distinction that earns `/health` its demotion is that a probe fires when nothing is
 * happening, whereas every proxy line corresponds to real billable work and joins to a
 * `llm_call_metrics` row we already retain. Quieting it would blind the request stream exactly
 * where the traffic is.
 */
const QUIET_PATHS = new Set(['/health', '/ready'])

/**
 * Adopt a client-supplied request id when it is bounded and safe to echo, else mint one.
 * Exported for the unit test that pins the refusal cases — a header is untrusted input.
 */
export function resolveRequestId(supplied: string | undefined): string {
  if (supplied && supplied.length <= MAX_REQUEST_ID_LENGTH && SAFE_REQUEST_ID.test(supplied)) {
    return supplied
  }
  return crypto.randomUUID()
}

/**
 * The request-scoped logger, for a controller or helper that wants the request's correlation
 * fields without threading the context through. Falls back to the process-wide logger when the
 * middleware isn't mounted (a bare `new Hono()` in a unit test), so a call site never has to
 * branch.
 */
export function requestLogger<E extends AppEnv>(c: Context<E>): Logger {
  return c.get('log') ?? logger
}

/** The request id for this request, when the middleware is mounted. */
export function requestIdOf<E extends AppEnv>(c: Context<E>): string | undefined {
  return c.get('requestId')
}

/**
 * Mount the request-id + request-logging middleware. Call it FIRST — before `cors()`, the
 * per-request container and {@link mountAuthGate} — so nothing a facade mounts can produce a
 * response this never sees.
 *
 * `base` exists for tests; production passes the process-wide logger.
 */
export function mountRequestLogging<E extends AppEnv>(app: Hono<E>, base: Logger = logger): void {
  app.use('*', async (c, next) => {
    const requestId = resolveRequestId(c.req.header(REQUEST_ID_HEADER))
    const method = c.req.method
    // The PATHNAME only, never the raw URL: a query string routinely carries a token (the
    // WebSocket `?ticket=`, an OAuth `?code=`) and this value lands in every line for the
    // request. Route params stay in the path, which is what makes a line greppable at all.
    // `c.req.path` is Hono's own already-computed pathname (a string slice, no URL parse) —
    // identical value, and this runs on every request including the LLM proxy's hot path.
    const path = c.req.path
    // A caller that is already collecting a distributed trace (an SDK client, a gateway, a
    // sibling service) tells us so with `traceparent`. Adopting it binds the correlation onto
    // the request's child logger, so every line this request produces is exported INTO the
    // caller's trace instead of alongside it: the join an operator otherwise has to make by
    // hand, from a request id they had to think to copy.
    //
    // Bound HERE rather than resolved at the exporter because this is the only scope that can
    // see the header, and it costs one bind for the whole request instead of a per-line read.
    // Absent or malformed ⇒ nothing is bound and the line correlates exactly as it did before.
    const trace = parseTraceparent(c.req.header(TRACEPARENT_HEADER))
    const log = base.child({
      requestId,
      method,
      path,
      ...(trace ? { [TRACE_ID_FIELD]: trace.traceId, [SPAN_ID_FIELD]: trace.spanId } : {}),
    })
    c.set('requestId', requestId)
    c.set('log', log)

    // On workerd `Date.now()` is frozen between I/O operations, so this reads 0 for a request
    // that performs none and otherwise snaps to the last I/O boundary rather than true wall
    // clock. It is a coarse "was this slow" signal, never a latency measurement — and for a
    // STREAMED response (the LLM proxy) it covers time-to-headers, not time-to-last-byte,
    // because `next()` resolves as soon as the handler returns the Response.
    const startedAt = Date.now()
    await next()
    const durationMs = Date.now() - startedAt

    const status = c.res.status
    // 101 is a WebSocket upgrade. Hono implements a post-`next()` `c.header()` by REBUILDING
    // the response (`new Response(body, res)`), which on Cloudflare drops the `webSocket`
    // property the runtime hands back to the client — i.e. setting a header here would break
    // the SPA's live event stream on the deployed runtime while every test that speaks plain
    // HTTP stayed green. The id is still logged; an upgrade has no response body to read it
    // from anyway.
    if (status !== 101) c.header(REQUEST_ID_HEADER, requestId)

    // The code `errorHandler` mapped, when the failure came through it. A controller that
    // RETURNS a 4xx envelope directly (rather than throwing a DomainError) leaves this unset,
    // so it is a bonus field, never a promise.
    const errorCode = c.get('errorCode')
    const fields = { status, durationMs, ...(errorCode ? { errorCode } : {}) }
    if (status >= 500) log.error('request failed', fields)
    else if (status >= 400) log.warn('request rejected', fields)
    else if (QUIET_PATHS.has(path)) log.debug('request completed', fields)
    else log.info('request completed', fields)
  })
}
