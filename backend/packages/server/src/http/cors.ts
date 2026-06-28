// CORS origin policy. The set of allowed browser Origins is configuration, not
// code: this is a self-hosted system, so each provisioning org declares its own
// frontend origin(s) (comma-separated). A lone `*` — or no value at all — allows
// any origin, which is safe here because every route is bearer-gated and fails
// closed; pinning origins is defense-in-depth.

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
 * - No allowlist configured, or it contains `*` → allow any origin (echo it).
 * - Otherwise → echo the origin only when it's explicitly listed.
 * - No request Origin (non-browser caller) → `null`; CORS doesn't apply.
 */
export function resolveCorsOrigin(
  requestOrigin: string | undefined | null,
  configured: string | undefined,
): string | null {
  if (!requestOrigin) return null
  const allowed = parseAllowedOrigins(configured)
  if (allowed.length === 0 || allowed.includes('*')) return requestOrigin
  return allowed.includes(requestOrigin) ? requestOrigin : null
}
