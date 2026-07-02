// CORS origin policy. The set of allowed browser Origins is configuration, not
// code: this is a self-hosted system, so each provisioning org declares its own
// frontend origin(s) (comma-separated). A lone `*` explicitly opts into reflecting
// any origin. An UNSET allowlist reflects any origin ONLY in a non-production
// environment (dev/test convenience); a production deployment that forgets to set
// CORS_ALLOWED_ORIGINS denies cross-origin rather than silently reflecting. Auth is a
// bearer header (not cookies) and credentials mode is off, so this is defense-in-depth.

/** Deployment ENVIRONMENT values treated as production for the CORS default. */
const PRODUCTION_ENVIRONMENTS = new Set(['production', 'prod', 'staging'])

/**
 * Whether an unset `CORS_ALLOWED_ORIGINS` should reflect any origin: yes outside a
 * production-like `ENVIRONMENT` (dev/test convenience), no in production (default-deny).
 * Pass the deployment's `ENVIRONMENT` env value.
 */
export function corsReflectsWhenUnset(environment: string | undefined): boolean {
  return !PRODUCTION_ENVIRONMENTS.has((environment ?? '').trim().toLowerCase())
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
 */
export const CORS_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-Personal-Password',
  'X-Connection-Id',
]

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
