import { registerCoreControllers } from '@cat-factory/server'
import type { CoreDependencies } from '@cat-factory/orchestration'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { resolveCorsOrigin } from './infrastructure/config/cors'
import { buildContainer } from './infrastructure/container'
import { handleError } from './infrastructure/http/errorHandler'
import type { AppEnv } from './infrastructure/http/types'
import { requireAuth } from './infrastructure/auth/middleware'
import { authController } from './modules/auth/AuthController'
import { eventsController } from './modules/events/EventsController'
import { githubController } from './modules/github/GitHubController'
import { githubWebhookController } from './modules/github/GitHubWebhookController'
import { llmProxyController } from './modules/llmProxy/LlmProxyController'

export interface CreateAppOptions {
  /** Override core dependencies — used by tests (e.g. a fake agent executor). */
  overrides?: Partial<CoreDependencies>
}

/**
 * Assembles the Hono application. A per-request middleware builds the DI
 * container from the request's `env` bindings and stashes it on the context, so
 * controllers resolve their services from `c.get('container')`.
 *
 * The bulk of the controllers are runtime-neutral and live in @cat-factory/server
 * (`registerCoreControllers`); the Worker mounts only its own runtime-coupled
 * controllers — the LLM proxy (Workers AI binding), the WebSocket event stream
 * (Durable Object), the GitHub webhook (Queue) and connect (Workflow), and the
 * OAuth login flow.
 */
export function createApp(options: CreateAppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // CORS allowlist is per-deployment configuration (CORS_ALLOWED_ORIGINS), not
  // hardcoded, since each org provisions this system with its own frontend
  // origin(s). Unset / `*` allows any origin — safe because every route is
  // bearer-gated and fails closed; pinning origins is defense-in-depth. Auth is a
  // bearer header (not cookies), so credentials mode stays off.
  app.use(
    '*',
    cors({
      origin: (origin, c) => resolveCorsOrigin(origin, c.env.CORS_ALLOWED_ORIGINS),
      allowHeaders: ['Content-Type', 'Authorization'],
    }),
  )
  app.use('*', async (c, next) => {
    c.set('container', buildContainer(c.env, options.overrides))
    await next()
  })

  app.get('/health', (c) => c.json({ status: 'ok' }))

  // Default-deny: every route requires a valid session EXCEPT the prefixes below,
  // which are either public by necessity or carry their own authentication. The
  // gate fails closed when auth is unconfigured (503) unless AUTH_DEV_OPEN is set
  // for local dev — so production is always authenticated, and any new route is
  // protected unless it is explicitly added to this allowlist.
  //   /health   — liveness probe (no data).
  //   /auth     — the login flow itself; can't require a session to obtain one.
  //   /v1       — container LLM proxy; authenticated by a model-locked session
  //               token (ContainerSessionService), not the workspace session.
  //   /github   — GitHub webhooks + setup callback; verified by HMAC signature.
  const PUBLIC_PREFIXES = ['/health', '/auth', '/v1', '/github']
  const gate = requireAuth<AppEnv>()
  app.use('*', (c, next) => {
    if (c.req.method === 'OPTIONS') return next()
    const path = c.req.path
    // The WebSocket event stream authenticates via ?token= inside its handler (a
    // browser can't set Authorization on a WS handshake). Bypass ONLY the exact
    // GET upgrade for /workspaces/:id/events; everything else stays default-deny.
    if (
      c.req.method === 'GET' &&
      c.req.header('Upgrade')?.toLowerCase() === 'websocket' &&
      /^\/workspaces\/[^/]+\/events$/.test(path)
    ) {
      return next()
    }
    if (PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return next()
    return gate(c, next)
  })

  // Per-workspace authorization. The gate above only proves the caller is signed
  // in; this binds the signed-in user to the `:workspaceId` they are addressing,
  // so one user cannot read or mutate a board outside the accounts they belong to.
  //   - Runs only when a user is set: when auth is disabled (dev) or for the
  //     self-authenticating WS upgrade (gate-bypassed, no user), it is a no-op.
  //   - `/workspaces` (list/create) has no :id and is skipped here.
  //   - Access is granted when the user is a member of the board's account; a
  //     legacy account-less board is still readable by the user who owns it.
  //   - Anything else — including a board in an account the user doesn't belong to
  //     — is reported as 404 (not 403) so existence isn't leaked.
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

  // OpenAI-compatible LLM proxy for implementation containers. Authenticated by a
  // signed, model-locked session token (not the workspace session); on the
  // /v1 public-prefix allowlist above so requireAuth doesn't double-gate it.
  app.route('/', llmProxyController())

  // "Login with GitHub" (public; no-op endpoints when auth is unconfigured).
  app.route('/auth', authController())

  // The runtime-neutral API layer — controllers shared across every facade.
  registerCoreControllers(app)

  // Worker-specific runtime controllers (Durable Objects / Queues / Workflows):
  //   - the real-time WebSocket event stream (self-authenticates via ?token=; the
  //     gate above bypasses only its exact upgrade shape),
  //   - GitHub connect/resync (kicks the backfill Workflow),
  //   - the GitHub webhook + setup callback (HMAC-verified; enqueues to the sync Queue).
  app.route('/', eventsController())
  app.route('/workspaces/:workspaceId', githubController())
  app.route('/github', githubWebhookController())

  app.onError(handleError)

  return app
}
