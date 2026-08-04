import type { Context, ExecutionContext, Hono } from 'hono'
import type { AppEnv } from './env.js'
import { REQUEST_ID_HEADER, requestIdOf } from './requestLogging.js'

// Re-entering this app's own HTTP surface from inside a request.
//
// One route needs it: the hosted MCP endpoint (`PublicMcpController`), which serves a protocol whose
// every operation is an `/api/v1` call. Handing it this instead of a service layer is what makes the
// hosted endpoint and the published stdio server incapable of answering differently: both drive the
// SAME generated tool table over the SAME SDK client, and the only difference is where that client's
// requests land.
//
// A dispatch through the app rather than a real `fetch` to the deployment's own origin, because a
// loopback over the network needs an origin to aim at — which a facade behind a proxy, a preview URL
// or a private hostname cannot reliably derive from the request it is answering — and spends a
// second connection to reach code already in memory. Going through `app.fetch` keeps the inner call
// honest all the same: it re-runs the auth gate, the per-request container build and the key
// authentication, so nothing gets a privilege the same request over the wire would not have.

/** Dispatch a synthetic request through the app that owns `c`. */
export type AppLoopback<E extends AppEnv> = (request: Request, c: Context<E>) => Promise<Response>

/**
 * Build the loopback for an app.
 *
 * Takes the app rather than being a method on it so the routes that use it receive a
 * single bound callback: a controller holding the whole app could mount onto it.
 *
 * The runtime handles are forwarded, not dropped. `env` carries the facade's bindings, without which
 * the inner request cannot build a container at all on the Worker; `executionCtx` is what keeps the
 * isolate alive for post-response work, so an inner handler's telemetry write would otherwise be
 * silently discarded exactly where `makeWaitUntil` was added to prevent that.
 *
 * The CORRELATION ID is forwarded for the same reason: `mountRequestLogging` adopts an inbound
 * `X-Request-Id` rather than always minting one, so passing the outer request's along is what puts
 * the MCP call and the `/api/v1` calls it caused on one greppable id. Without it the inner request
 * mints its own and the only question worth asking of these logs — which tool call produced this
 * 422 — has no answer.
 */
export function appLoopback<E extends AppEnv>(app: Hono<E>): AppLoopback<E> {
  return async (request, c) => app.fetch(withRequestId(request, c), c.env, executionCtxOf(c))
}

/**
 * The request with the caller's correlation id bound, or unchanged when there is none to bind.
 *
 * Rebuilt rather than mutated: a `Request`'s header guard is permissive for a constructed one and
 * not for every runtime's inbound one, and this receives whichever the caller passed. An id the
 * inner request already carries WINS, so a future loopback caller that wants its own can set one.
 */
function withRequestId<E extends AppEnv>(request: Request, c: Context<E>): Request {
  const requestId = requestIdOf(c)
  if (!requestId || request.headers.has(REQUEST_ID_HEADER)) return request
  const headers = new Headers(request.headers)
  headers.set(REQUEST_ID_HEADER, requestId)
  return new Request(request, { headers })
}

/**
 * The request's `executionCtx`, or undefined on a runtime that has none.
 *
 * Hono's accessor THROWS rather than answering undefined (Node has no such context, and neither does
 * a test driving `app.fetch` with two arguments), so reading it is a try/catch — the same shape
 * `makeWaitUntil` uses next door.
 */
function executionCtxOf<E extends AppEnv>(c: Context<E>): ExecutionContext | undefined {
  try {
    return c.executionCtx
  } catch {
    // silent-catch-ok: the absence IS the answer, and the caller's undefined branch handles it.
    return undefined
  }
}
