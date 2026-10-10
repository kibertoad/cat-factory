// CORS origin policy. The set of allowed browser Origins is configuration, not
// code: this is a self-hosted system, so each provisioning org declares its own
// frontend origin(s) (comma-separated). A lone `*` explicitly opts into reflecting
// any origin. An UNSET allowlist reflects any origin ONLY when ENVIRONMENT is an
// explicitly recognised development value (dev/test convenience); an unset, unknown, or
// production ENVIRONMENT default-denies, so a deployment that forgets to set
// CORS_ALLOWED_ORIGINS fails safe rather than silently reflecting. Auth is a bearer
// header (not cookies) and credentials mode is off, so this is defense-in-depth.

/**
 * Deployment ENVIRONMENT values that are EXPLICITLY non-production, where an unset
 * `CORS_ALLOWED_ORIGINS` may reflect any origin as a dev/test convenience. The reflect
 * behaviour is opt-in on one of these values — NOT the default — so a production
 * deployment that sets neither `ENVIRONMENT` nor `CORS_ALLOWED_ORIGINS` fails safe
 * (default-deny) rather than silently reflecting. e2e/dev set their own
 * `CORS_ALLOWED_ORIGINS` anyway, so they're unaffected by the stricter default.
 */
const DEVELOPMENT_ENVIRONMENTS = new Set(['development', 'dev', 'test', 'testing', 'local', 'e2e'])

/**
 * Whether an unset `CORS_ALLOWED_ORIGINS` should reflect any origin: yes only when
 * `ENVIRONMENT` is an explicitly recognised development value (dev/test convenience), no
 * otherwise — an UNSET, unknown, or production `ENVIRONMENT` all default-deny. Pass the
 * deployment's `ENVIRONMENT` env value.
 */
export function corsReflectsWhenUnset(environment: string | undefined): boolean {
  return DEVELOPMENT_ENVIRONMENTS.has((environment ?? '').trim().toLowerCase())
}

/**
 * The request headers the browser is allowed to send cross-origin (the preflight
 * `Access-Control-Allow-Headers` response). Shared by every runtime facade so the
 * two CORS configs can't drift: the SPA sends each of these on its API calls, so a
 * header missing here makes the browser drop the whole request ("CORS Missing Allow
 * Header") even though the route itself is fine.
 * - `Authorization` — the bearer session token.
 * - `X-Personal-Password` — the ambient personal-subscription unlock password.
 * - `X-Connection-Id` — the per-tab connection id used for real-time self-echo
 *   suppression (see the SPA's `connectionId()` / `BoardController`).
 * - `X-Request-Id` — the correlation id (`mountRequestLogging`). Allowed INBOUND so a
 *   caller that already has one (a load balancer, another service) can propagate it
 *   rather than have the backend mint a second, unrelated id for the same request.
 * - `Mcp-Protocol-Version` — the negotiated protocol version an MCP client sends to the
 *   hosted endpoint (`POST /api/v1/mcp`). A Streamable HTTP client sends it on every
 *   request AFTER `initialize` and on none before, so leaving it out fails in the shape
 *   that reads as a working endpoint: the handshake preflight asks only for headers
 *   already listed above and succeeds, then every real call is dropped by the browser.
 *   The session header has no entry on purpose — that endpoint is stateless and mints no
 *   session id, so a client never has one to send back.
 */
export const CORS_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-Personal-Password',
  'X-Connection-Id',
  'X-Request-Id',
  'Mcp-Protocol-Version',
]

/**
 * The response headers a cross-origin browser client may READ. Without an explicit
 * `Access-Control-Expose-Headers` a browser exposes only the CORS-safelisted set, so the
 * correlation id would be present on the wire and invisible to the SPA — which is the one
 * client whose users are the people quoting an id back in a bug report.
 *
 * `WWW-Authenticate` is here for the other kind of client: a browser-hosted MCP host reads that
 * header off the hosted endpoint's 401 to find this deployment's protected-resource metadata, which
 * is the entry point to the whole authorization flow. Unexposed, the header is on the wire and
 * invisible to exactly the client that cannot connect without it.
 */
export const CORS_EXPOSED_HEADERS = ['X-Request-Id', 'WWW-Authenticate']

/**
 * The path prefixes served to ANY browser origin, whatever `CORS_ALLOWED_ORIGINS` says.
 *
 * These are the routes of this deployment's own MCP authorization server, and they are the exact
 * complement of the deployment's allowlist rather than a hole in it. The allowlist exists to name
 * the browser origins that may drive an EXISTING credential's surface; every route under these two
 * prefixes is reached by a party that has no credential and no relationship with this deployment
 * yet, which is what it is here to obtain, and the hosts the flow exists for (claude.ai, the
 * browser-side IDE clients) run on origins no operator can be expected to have listed. So a
 * per-deployment allowlist here does not restrict an attacker, who reads these documents from a
 * server with no browser involved: it restricts exactly the legitimate client the feature is for.
 *
 * The reason this is a PATH rule in the shared CORS layer rather than a header set on a handler:
 * the browser asks first. A `POST /oauth/register` with a JSON body is preflighted, and a
 * preflight is answered by this middleware before any route runs, so a header the handler sets is
 * a header nobody reached. That is the shape the metadata documents alone had, and it read as
 * working: discovery is a simple GET with no preflight, so a browser host could read the whole
 * chain and then fail on the first call that acts on it.
 *
 * Nothing under them carries ambient authority. There are no cookies (auth is a bearer header and
 * credentials mode is off), the routes sit in `PUBLIC_PREFIXES` because they authenticate nobody,
 * and the token exchange proves itself with a PKCE verifier that never left the host. A page on
 * another origin can already make every one of these calls from its own server.
 */
const PUBLICLY_READABLE_PREFIXES = ['/.well-known', '/oauth']

/** Whether a path is served to any browser origin (see {@link PUBLICLY_READABLE_PREFIXES}). */
export function isPubliclyReadablePath(pathname: string): boolean {
  return PUBLICLY_READABLE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}

/**
 * The `Access-Control-Allow-Origin` value for one request: the allowlist decision
 * ({@link resolveCorsOrigin}), except on the credential-free discovery and authorization paths,
 * which answer any origin.
 *
 * Both facades call THIS rather than `resolveCorsOrigin` directly, so the two cannot drift on which
 * paths are public: a browser-hosted MCP client either connects to both facades or to neither.
 */
export function corsOriginFor(
  pathname: string,
  requestOrigin: string | undefined | null,
  configured: string | undefined,
  reflectWhenUnset = true,
): string | null {
  if (isPubliclyReadablePath(pathname)) return requestOrigin ?? null
  return resolveCorsOrigin(requestOrigin, configured, reflectWhenUnset)
}

/** Parse a comma-separated allowed-origins string into trimmed entries. */
export function parseAllowedOrigins(configured: string | undefined): string[] {
  return (configured ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
}

/**
 * Resolve the value for `Access-Control-Allow-Origin` for one request, given the
 * request's `Origin` and the configured allowlist. Returns the origin to echo
 * back (so it works without credentials), or `null` to omit the header.
 *
 * - Allowlist contains `*` → allow any origin (explicit opt-in).
 * - Allowlist has entries → echo the origin only when it's explicitly listed.
 * - Allowlist unset/empty → reflect any origin when `reflectWhenUnset` (non-production),
 *   else `null` (production default-deny).
 * - No request Origin (non-browser caller) → `null`; CORS doesn't apply.
 */
export function resolveCorsOrigin(
  requestOrigin: string | undefined | null,
  configured: string | undefined,
  reflectWhenUnset = true,
): string | null {
  if (!requestOrigin) return null
  const allowed = parseAllowedOrigins(configured)
  if (allowed.includes('*')) return requestOrigin
  if (allowed.length === 0) return reflectWhenUnset ? requestOrigin : null
  return allowed.includes(requestOrigin) ? requestOrigin : null
}
