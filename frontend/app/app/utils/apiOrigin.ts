/**
 * Where the SPA's API lives, resolved from the build-time `runtimeConfig.public.apiBase`.
 *
 * Two deployment topologies are supported and they differ ONLY here:
 *
 * - **Split origins** (the production Cloudflare/Node deployments): `apiBase` is an absolute
 *   origin (`https://api.example.com`), the SPA is served from a different one, and the backend
 *   allow-lists the SPA via `CORS_ALLOWED_ORIGINS`.
 * - **Same origin**: `apiBase` is EMPTY and one reverse proxy serves both the static SPA and the
 *   API (the compose preview stack in `deploy/preview/compose`). REST calls are then relative and
 *   need nothing extra — but the WebSocket URL does, because the socket origin cannot be derived
 *   from an empty string. That is what this module exists for: it substitutes the PAGE's origin,
 *   so the stream connects to whatever host/port the stack happens to be published on. A preview
 *   stack's host port is assigned at `up` time, so it is not knowable when the SPA is built —
 *   same-origin is the only topology that works there.
 */

/** The API origin the SPA should talk to: `apiBase` when set, else the page's own origin. */
export function apiOriginFor(apiBase: string, pageOrigin: string): string {
  return apiBase.trim() || pageOrigin
}

/**
 * The WebSocket origin (`http`→`ws`, `https`→`wss`) for the API. Falls back to `pageOrigin` for
 * the same-origin topology; returns `''` only when neither is known (SSR, where no socket is
 * opened anyway).
 */
export function wsOriginFor(apiBase: string, pageOrigin: string): string {
  return apiOriginFor(apiBase, pageOrigin).replace(/^http/, 'ws')
}
