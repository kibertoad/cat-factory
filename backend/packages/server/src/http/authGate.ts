import type { Hono } from 'hono'
import { requireAuth } from '../auth/middleware.js'
import type { AppEnv } from './env.js'

// The runtime-neutral authentication + authorization gate, shared by every facade.
// Each facade builds its own app (CORS, the per-request container, runtime-specific
// controllers) and calls `mountAuthGate(app)` BEFORE `registerCoreControllers(app)` —
// so the security-critical default-deny + per-workspace ownership checks have ONE
// implementation and cannot drift between the Cloudflare Worker and the Node service.
// The gate reads the container the facade stashed on the context, so it works
// identically regardless of how that container was assembled.

// Routes that bypass the session gate: either public by necessity or carrying their
// own authentication.
//   /health   — liveness probe (no data).
//   /auth     — the login flow itself; can't require a session to obtain one.
//   /v1       — container LLM proxy; authenticated by a model-locked session token
//               (ContainerSessionService), not the workspace session.
//   /github   — GitHub webhooks + setup callback; verified by HMAC signature.
//   /slack    — Slack OAuth callback; the `state` is HMAC-signed + short-lived.
//   /internal — mothership-mode machine API; authenticated by an audience-pinned machine
//               token verified inside the controller, not by the session gate.
const PUBLIC_PREFIXES = ['/health', '/auth', '/v1', '/github', '/slack', '/internal']

/** The exact WebSocket-upgrade shape that self-authenticates via `?ticket=`. */
const WS_EVENTS_PATH = /^\/workspaces\/[^/]+\/events$/

/**
 * Mount the default-deny session gate and the per-workspace authorization check.
 *
 * 1. Default-deny: every route requires a valid session EXCEPT {@link PUBLIC_PREFIXES}
 *    and the exact WS event-stream upgrade (a browser can't set `Authorization` on a
 *    WS handshake, so it authenticates via `?ticket=` inside its handler). The gate
 *    fails closed (503) when auth is unconfigured unless `AUTH_DEV_OPEN` is set, so
 *    production is always authenticated and any new route is protected by default.
 * 2. Per-workspace authz: binds the signed-in user to the `:workspaceId` they address
 *    so one user cannot read or mutate a board outside the accounts they belong to. A
 *    board in an account the user doesn't belong to is reported as 404 (not 403) so
 *    existence isn't leaked. Runs only when a user is set (no-op for dev-open / the
 *    self-authenticating WS upgrade) and skips `/workspaces` (list/create, no `:id`).
 *
 * Call this AFTER the middleware that sets `container` on the context and BEFORE
 * `registerCoreControllers`.
 */
export function mountAuthGate<E extends AppEnv>(app: Hono<E>): void {
  const gate = requireAuth<E>()
  app.use('*', (c, next) => {
    if (c.req.method === 'OPTIONS') return next()
    const path = c.req.path
    if (
      c.req.method === 'GET' &&
      c.req.header('Upgrade')?.toLowerCase() === 'websocket' &&
      WS_EVENTS_PATH.test(path)
    ) {
      return next()
    }
    if (PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return next()
    return gate(c, next)
  })

  app.use('*', async (c, next) => {
    if (c.req.method === 'OPTIONS') return next()
    const user = c.get('user')
    if (!user) return next()
    const match = /^\/workspaces\/([^/]+)(?:\/.*)?$/.exec(c.req.path)
    if (!match) return next()
    const workspaceId = decodeURIComponent(match[1]!)
    const container = c.get('container')
    const accountId = await container.workspaceService.accountOf(workspaceId)
    if (accountId === undefined) return next() // missing board → let the handler 404 normally

    const notFound = () =>
      c.json({ error: { code: 'not_found', message: 'Workspace not found' } }, 404)

    if (accountId === null) {
      // Legacy/unscoped board: only the user who personally owns it may access it.
      const owner = await container.workspaceService.ownerOf(workspaceId)
      return owner === user.id ? next() : notFound()
    }
    if (await container.accountService.isMember(accountId, user.id)) return next()
    return notFound()
  })
}
