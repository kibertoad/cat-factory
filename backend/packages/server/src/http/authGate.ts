import { ForbiddenError, workspaceRoleAtLeast } from '@cat-factory/kernel'
import type { Hono } from 'hono'
import { requireAuth } from '../auth/middleware.js'
import type { AppEnv } from './env.js'
import { loadWorkspaceAccess } from './workspaceAccess.js'

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
//   /api      — the public external API; authenticated by an in-controller public-API key
//               (`Authorization: Bearer cf_live_…`), not the session gate.
const PUBLIC_PREFIXES = ['/health', '/auth', '/v1', '/github', '/slack', '/internal', '/api']

/** The exact WebSocket-upgrade shape that self-authenticates via `?ticket=`. */
const WS_EVENTS_PATH = /^\/workspaces\/[^/]+\/events$/

/**
 * The one write that is read-equivalent AND required for the pure *viewing* experience, so it
 * is allowlisted past the viewer floor: minting a read-only WebSocket stream ticket. A viewer
 * may watch a board's live stream (the stream carries only read-tier data), so this POST is
 * exempt from the "≥ member" floor.
 *
 * This is deliberately the ONLY exemption. Other non-GET routes that happen not to persist
 * anything — the `detect` / `plan` / `search` / `test` / `validate` / `preflight` / `probe`
 * endpoints that prefill a create/edit form or probe an integration connection — are NOT
 * allowlisted: they belong to the `member`+ authoring / integration-setup surface, not to
 * read-only viewing (a viewer never reaches them — the SPA gates those affordances by
 * permission). Blocking them behind the floor is intended; do NOT widen this allowlist to
 * "read-equivalent POST" as a class. If a genuinely viewing-required write is ever added,
 * add its own exact-path regex here alongside this one.
 */
const WS_TICKET_MINT_PATH = /^\/workspaces\/[^/]+\/events\/ticket$/

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

    // Resolve the caller's effective workspace-RBAC role once (the single decision point).
    // `null` ⇒ the board doesn't exist; pass through so the handler 404s as it always has.
    const access = await loadWorkspaceAccess(container, workspaceId, user.id)
    if (access === null) return next()

    // Denied ⇒ the SAME 404 shape the pre-RBAC gate returned, so existence isn't leaked.
    if (!access.allowed) {
      return c.json({ error: { code: 'not_found', message: 'Workspace not found' } }, 404)
    }

    // Publish the resolved access for the controllers (`requirePermission`) + the snapshot
    // attach; carrying `workspaceId` lets a helper assert it matches its route.
    c.set('workspaceAccess', {
      workspaceId,
      role: access.role,
      permissions: access.permissions,
    })

    // The viewer write floor: any state-changing method requires at least `member`. This
    // covers the whole member tier (`board.write` + `runs.execute`) with ZERO per-controller
    // code — a forgotten controller check fails safe. The sole read-equivalent write, the
    // read-only stream ticket mint, is allowlisted; the admin-tier route groups add their own
    // `requirePermission` on top (a later slice). Insufficiency ⇒ 403 (the caller already sees
    // the board, so only capability — not existence — is revealed).
    const method = c.req.method
    const isRead = method === 'GET' || method === 'HEAD'
    const isTicketMint = method === 'POST' && WS_TICKET_MINT_PATH.test(c.req.path)
    if (!isRead && !isTicketMint && !workspaceRoleAtLeast(access.role, 'member')) {
      throw new ForbiddenError('This action requires at least member access to this workspace')
    }
    return next()
  })
}
