import type { GateProviderOverrides } from '@cat-factory/gates'
import {
  buildMisconfiguredResponse,
  isConfigValidationError,
  mountAuthGate,
  registerCoreControllers,
} from '@cat-factory/server'
import type { CoreDependencies } from '@cat-factory/orchestration'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import {
  CORS_ALLOWED_HEADERS,
  corsReflectsWhenUnset,
  resolveCorsOrigin,
} from './infrastructure/config/cors'
import { buildContainer } from './infrastructure/container'
import { handleError } from './infrastructure/http/errorHandler'
import type { AppEnv } from './infrastructure/http/types'

export interface CreateAppOptions {
  /** Override core dependencies — used by tests (e.g. a fake agent executor). */
  overrides?: Partial<CoreDependencies>
  /** Force the Cloudflare-AI-enabled flag (conformance forces it off for parity). */
  cloudflareModelsEnabled?: boolean
  /** Explicit gate providers wired on every per-request build — used by tests. */
  gateProviders?: GateProviderOverrides
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
  // origin(s). An explicit `*` reflects any origin; an unset allowlist reflects only
  // in a non-production ENVIRONMENT (a production deployment that forgets it
  // default-denies). Auth is a bearer header (not cookies), so credentials mode stays off.
  app.use(
    '*',
    cors({
      origin: (origin, c) =>
        resolveCorsOrigin(
          origin,
          c.env.CORS_ALLOWED_ORIGINS,
          corsReflectsWhenUnset(c.env.ENVIRONMENT),
        ),
      // The shared allow-list (kept in @cat-factory/server so both facades match): the
      // SPA sends X-Personal-Password (personal-subscription unlock) and X-Connection-Id
      // (real-time self-echo suppression) on its calls, so each must be allow-listed or
      // the browser drops the whole request with "CORS Missing Allow Header".
      allowHeaders: [...CORS_ALLOWED_HEADERS],
    }),
  )
  app.use('*', async (c, next) => {
    try {
      c.set(
        'container',
        buildContainer(c.env, options.overrides, {
          cloudflareModelsEnabled: options.cloudflareModelsEnabled,
          gateProviders: options.gateProviders,
        }),
      )
    } catch (err) {
      // A mandatory binding / var is missing or invalid (e.g. TELEMETRY_DB unbound, ENCRYPTION_KEY
      // absent). Rather than 500-ing every request opaquely, serve the misconfiguration fallback so
      // the SPA renders its dedicated error screen listing exactly what to add to wrangler.toml. The
      // Worker rebuilds the container per request, so it recovers automatically once fixed. CORS
      // headers are added by the cors middleware above on the way out.
      if (isConfigValidationError(err)) {
        return buildMisconfiguredResponse(new URL(c.req.url).pathname, err.problems)
      }
      throw err
    }
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
