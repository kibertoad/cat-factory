import type { GateProviderOverrides } from '@cat-factory/gates'
import {
  type ConfigProblem,
  buildMisconfiguredResponse,
  isConfigValidationError,
  logger,
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

// The Worker builds its container per request, so a persistent misconfiguration would throw on
// every one. Log it ONCE per isolate per distinct problem-set (keyed by the var names) so an
// operator watching `wrangler tail` gets a clear server-side breadcrumb — mirroring the Node
// facade's `serveMisconfigured` log — without spamming a line for every request.
const loggedMisconfigs = new Set<string>()
function logMisconfiguredOnce(problems: ConfigProblem[]): void {
  const signature = problems
    .map((p) => p.key)
    .sort()
    .join(',')
  if (loggedMisconfigs.has(signature)) return
  loggedMisconfigs.add(signature)
  logger.error(
    { problems: problems.map((p) => p.key) },
    'Cloudflare Worker is MISCONFIGURED — serving the fallback error backend so the SPA can ' +
      'explain what to fix. Add the missing binding(s)/var(s) to wrangler.toml.',
  )
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
      // Worker rebuilds the container per request, so it recovers automatically once fixed.
      if (isConfigValidationError(err)) {
        logMisconfiguredOnce(err.problems)
        const res = buildMisconfiguredResponse(new URL(c.req.url).pathname, err.problems)
        // The cors() middleware above default-DENIES a cross-origin request when
        // CORS_ALLOWED_ORIGINS is unset in a production ENVIRONMENT — which would stop the SPA (a
        // separate Pages origin) from ever reading this error, defeating the whole feature exactly
        // when the deployment is most broken. The problem list carries no secret, so reflect the
        // caller's origin unconditionally here, matching the standalone `createMisconfiguredApp`.
        const origin = c.req.header('Origin')
        if (origin) res.headers.set('Access-Control-Allow-Origin', origin)
        return res
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
