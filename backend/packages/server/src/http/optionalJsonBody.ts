import type { MiddlewareHandler } from 'hono'

// ---------------------------------------------------------------------------
// A route whose contract declares an ALL-OPTIONAL request body must still accept
// a request that sends NO body at all.
//
// `buildHonoRoute` mounts a body validator for any contract carrying a
// `requestBodySchema`, and that validator reads `c.req.json()` FIRST — which
// throws on an absent/empty body and is surfaced as a 400 before the schema is
// ever consulted. So declaring `{ reviewEffort: v.optional(...) }` on a route
// that used to take no body silently breaks every body-less caller: the schema
// says "all fields optional", the transport says "a body is mandatory".
//
// That bites hardest on routes that GAIN an optional field: `POST /blocks/:id/merge`
// and `POST /notifications/:id/act` were body-less for their whole life, and are
// still called that way by the SPA, by headless API clients, and by the
// conformance suite. Mount this ahead of such a route and an absent body is read
// as `{}` — the documented "historical no-body call" — while a body that IS sent
// validates exactly as before.
//
// Deliberately opt-in per route rather than global: a route whose body is
// genuinely required must keep failing loudly on an empty one, and mounting this
// explicitly documents at the call site which routes are body-optional.
// ---------------------------------------------------------------------------

/** Whether the request carries no readable body (no stream, or an explicitly empty one). */
function hasNoBody(request: Request): boolean {
  if (request.body === null) return true
  // A client that sets `Content-Length: 0` (or an empty `application/x-www-form-urlencoded`
  // form) can still hand us a non-null but empty stream, which `json()` rejects identically.
  return request.headers.get('content-length') === '0'
}

/**
 * Normalise an absent request body to `{}` so an all-optional body schema validates it.
 *
 * Mount it BEFORE the contract route it guards, so it runs ahead of the body validator:
 *
 * ```ts
 * app.use('/blocks/:blockId/merge', optionalJsonBody)
 * buildHonoRoute(app, mergeBlockContract, handler)
 * ```
 */
export const optionalJsonBody: MiddlewareHandler = async (c, next) => {
  const request = c.req.raw
  if (hasNoBody(request)) {
    const headers = new Headers(request.headers)
    headers.set('content-type', 'application/json')
    headers.delete('content-length')
    // Replace the raw request rather than reaching into Hono's body cache: `c.req.json()`
    // reads through to `raw`, so this is the supported way to make the validator see a body.
    c.req.raw = new Request(request.url, { method: request.method, headers, body: '{}' })
  }
  await next()
}
