import type { GateProviderOverrides } from '@cat-factory/gates'
import {
  type ConfigProblem,
  buildMisconfiguredResponse,
  isConfigValidationError,
  logger,
  mountAuthGate,
  mountRequestLogging,
  registerCoreControllers,
} from '@cat-factory/server'
import type { CoreDependencies } from '@cat-factory/orchestration'
import type { ToolSecretResolver } from '@cat-factory/kernel'
import type { Env } from './infrastructure/env'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import {
  CORS_ALLOWED_HEADERS,
  CORS_EXPOSED_HEADERS,
  corsReflectsWhenUnset,
  resolveCorsOrigin,
} from './infrastructure/config/cors'
import { buildContainer } from './infrastructure/container'
import { registerToolSecretPolicy } from './infrastructure/toolSecretResolver'
import { handleError } from './infrastructure/http/errorHandler'
import type { AppEnv } from './infrastructure/http/types'

export interface CreateAppOptions {
  /** Override core dependencies — used by tests (e.g. a fake agent executor). */
  overrides?: Partial<CoreDependencies>
  /** Force the Cloudflare-AI-enabled flag (conformance forces it off for parity). */
  cloudflareModelsEnabled?: boolean
  /** Explicit gate providers wired on every per-request build — used by tests. */
  gateProviders?: GateProviderOverrides
  /**
   * Build the resolver that supplies a registered capability's CREDENTIALS at dispatch: a tool
   * server's (MCP) and a generative binary integration's alike. Called with the `env` of whichever
   * entry point is building a container. Absent, the platform composes its own per-workspace
   * credential store in front of `createEnvToolSecretResolver(env)`.
   *
   * A FACTORY because the Worker has no ambient environment: a deployment reading its own sealed
   * per-workspace store, or the Cloudflare Secrets Store, reaches it through a BINDING on `env`.
   * The same shape as the Node/local facades' option, so a deployment writes one thing:
   *
   *     createToolSecretResolver: (env) => createEnvToolSecretResolver(env, { allowKeys: [...] })
   *
   * Setting it here REGISTERS it process-wide (`registerToolSecretPolicy`) rather than
   * closing over this app, because container agents are dispatched by the durable driver, which
   * builds its own container from a bare `buildContainer(env)` and would never see an option held
   * on the app. Same reason, same mechanism as `registerModelRegistry`.
   *
   * This is what `ToolSecretResolver` is a port FOR. `overrides` cannot serve it: its nearest
   * `CoreDependencies` field is the whole `agentExecutor`.
   */
  createToolSecretResolver?: (env: Env) => ToolSecretResolver
  /**
   * Whether the Worker's own configured vars answer a capability credential the workspace has NOT
   * stored. Defaults to true, which is right for a single-tenant deployment: the operator sets the
   * var they already set for everything else.
   *
   * A MULTI-TENANT deployment sets it false, so a tenant that has typed nothing resolves nothing
   * rather than silently running on whoever set the var and billing that vendor account. It also
   * stops the credential checklist telling an operator a blank row may still resolve.
   *
   * Registered process-wide with the resolver above, and for the same reason. Ignored when
   * `createToolSecretResolver` is set, which replaces the chain outright.
   */
  capabilityCredentialEnvironmentFallback?: boolean
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
    'Cloudflare Worker is MISCONFIGURED — serving the fallback error backend so the SPA can ' +
      'explain what to fix. Add the missing binding(s)/var(s) to wrangler.toml.',
    { problems: problems.map((p) => p.key) },
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

  // Process-wide rather than closed over this app, so the resolver also serves the container the
  // DURABLE DRIVER builds. See `infrastructure/toolSecretResolver.ts`: container agents (the only
  // dispatches that resolve a capability credential) are advanced by `ExecutionWorkflow`, which
  // never sees these options. Done here rather than in `createWorker` so a deployment assembling
  // its own app from `createApp` gets the same reach.
  if (
    options.createToolSecretResolver ||
    options.capabilityCredentialEnvironmentFallback !== undefined
  ) {
    registerToolSecretPolicy({
      ...(options.createToolSecretResolver
        ? { createResolver: options.createToolSecretResolver }
        : {}),
      ...(options.capabilityCredentialEnvironmentFallback === undefined
        ? {}
        : { environmentFallback: options.capabilityCredentialEnvironmentFallback }),
    })
  }

  // Correlation FIRST — before CORS and before the container build — so a CORS denial and the
  // misconfiguration fallback below are logged and carry an id like any other response. Shared
  // verbatim with the Node service.
  mountRequestLogging(app)

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
      // …and the correlation id back out, or the SPA can see it on the wire but not read it.
      exposeHeaders: [...CORS_EXPOSED_HEADERS],
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

  // Readiness (slice 4.3). The Worker has no long-lived process to drain and no rotation to be
  // taken out of — Cloudflare routes every request to a fresh isolate and there is nothing an
  // operator could do with a red answer — so `/ready` here is deliberately NOT the Node
  // facade's drain signal. What it IS: a bindings probe, answering the one question an operator
  // actually asks of a fresh deployment ("is D1 reachable, is TELEMETRY_DB bound"), which on
  // this runtime is a genuinely separate database rather than a schema in the same one.
  //
  // Reported per binding rather than as one boolean, and a failure is 503 so a smoke test can
  // assert on the status alone. Public, before the auth gate, like `/health`.
  app.get('/ready', async (c) => {
    const env = c.env
    const probe = async (run: () => Promise<unknown>): Promise<{ ok: boolean; error?: string }> => {
      try {
        await run()
        return { ok: true }
      } catch (err) {
        // Kept to a short diagnostic: this endpoint is unauthenticated, so it must never carry
        // a connection string or a binding's internals — the same rule as the Node twin's.
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
    const checks: Record<string, { ok: boolean; error?: string }> = {
      database: await probe(() => c.env.DB.prepare('SELECT 1').first()),
    }
    // TELEMETRY_DB is REQUIRED (the build fails without it), so an absent binding is a real
    // failure to report rather than a capability to skip.
    checks.telemetry = env.TELEMETRY_DB
      ? await probe(() => env.TELEMETRY_DB!.prepare('SELECT 1').first())
      : { ok: false, error: 'TELEMETRY_DB is not bound' }
    // AUDIT_DB is REQUIRED for the same reason, and reported here for a sharper one: an
    // unbound audit database does not break any request, it just silently records nothing,
    // so readiness is the only place a deployment finds out before it needs the trail.
    checks.audit = env.AUDIT_DB
      ? await probe(() => env.AUDIT_DB!.prepare('SELECT 1').first())
      : { ok: false, error: 'AUDIT_DB is not bound' }
    const ready = Object.values(checks).every((check) => check.ok)
    return c.json({ status: ready ? 'ready' : 'not_ready', checks }, ready ? 200 : 503)
  })

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
