import { mountAuthGate, registerCoreControllers } from '@cat-factory/server'
import type { CoreDependencies } from '@cat-factory/orchestration'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { resolveCorsOrigin } from './infrastructure/config/cors'
import { buildContainer } from './infrastructure/container'
import { handleError } from './infrastructure/http/errorHandler'
import type { AppEnv } from './infrastructure/http/types'

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
      // X-Personal-Password carries the ambient personal-subscription unlock password
      // (individual-usage vendors); it must be allow-listed or the browser drops it.
      allowHeaders: ['Content-Type', 'Authorization', 'X-Personal-Password'],
    }),
  )
  app.use('*', async (c, next) => {
    c.set('container', buildContainer(c.env, options.overrides))
    await next()
  })

  app.get('/health', (c) => c.json({ status: 'ok' }))

  // Default-deny session gate + per-workspace authz, shared verbatim with the Node
  // service (one implementation in @cat-factory/server so the runtimes can't drift).
  mountAuthGate(app)

  // The runtime-neutral API layer — every controller is shared across facades. Their
  // runtime seams (WebSocket upgrade, backfill Workflow, sync Queue, the LLM proxy's
  // Workers AI binding + upstreams) are delegated to the Worker's gateways (see
  // buildContainer's `gateways`).
  registerCoreControllers(app)

  app.onError(handleError)

  return app
}
