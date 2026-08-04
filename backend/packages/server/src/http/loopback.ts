import type { Context, ExecutionContext, Hono } from 'hono'
import type { AppEnv } from './env.js'

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
 */
export function appLoopback<E extends AppEnv>(app: Hono<E>): AppLoopback<E> {
  return async (request, c) => app.fetch(request, c.env, executionCtxOf(c))
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
