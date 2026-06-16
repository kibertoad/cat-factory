import type { CoreDependencies } from '@cat-factory/core'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { buildContainer } from './infrastructure/container'
import { handleError } from './infrastructure/http/errorHandler'
import type { AppEnv } from './infrastructure/http/types'
import { requireAuth } from './infrastructure/auth/middleware'
import { authController } from './modules/auth/AuthController'
import { boardController } from './modules/board/BoardController'
import { executionController } from './modules/execution/ExecutionController'
import { eventsController } from './modules/events/EventsController'
import { pipelineController } from './modules/pipelines/PipelineController'
import { workspaceController } from './modules/workspaces/WorkspaceController'
import { githubController } from './modules/github/GitHubController'
import { githubWebhookController } from './modules/github/GitHubWebhookController'
import { documentSourceController } from './modules/documents/DocumentSourceController'
import { environmentController } from './modules/environments/EnvironmentController'
import { runnerPoolController } from './modules/runners/RunnerPoolController'
import { bootstrapController } from './modules/bootstrap/BootstrapController'
import { boardScanController } from './modules/boardScan/BoardScanController'
import { promptFragmentController } from './modules/promptFragments/PromptFragmentController'
import { modelController } from './modules/models/ModelController'
import { llmProxyController } from './modules/llmProxy/LlmProxyController'

export interface CreateAppOptions {
  /** Override core dependencies — used by tests (e.g. a fake agent executor). */
  overrides?: Partial<CoreDependencies>
}

/**
 * Assembles the Hono application. A per-request middleware builds the DI
 * container from the request's `env` bindings and stashes it on the context, so
 * controllers resolve their services from `c.get('container')`.
 */
export function createApp(options: CreateAppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.use('*', cors({ allowHeaders: ['Content-Type', 'Authorization'] }))
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
  const gate = requireAuth()
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

  // Read-only best-practice fragment catalog (gated).
  app.route('/', promptFragmentController())

  // Read-only model picker catalog (gated; resolved to each model's active flavour).
  app.route('/', modelController())

  // OpenAI-compatible LLM proxy for implementation containers. Authenticated by a
  // signed, model-locked session token (not the workspace session); on the
  // /v1 public-prefix allowlist above so requireAuth doesn't double-gate it.
  app.route('/', llmProxyController())

  // "Login with GitHub" (public; no-op endpoints when auth is unconfigured).
  app.route('/auth', authController())

  // API layer — controllers grouped by module (all behind the default-deny gate).
  app.route('/', workspaceController())
  app.route('/workspaces/:workspaceId', boardController())
  app.route('/workspaces/:workspaceId', pipelineController())
  app.route('/workspaces/:workspaceId', executionController())
  // Real-time WebSocket event stream (self-authenticates via ?token=; the gate
  // above bypasses only its exact upgrade shape).
  app.route('/', eventsController())
  app.route('/workspaces/:workspaceId', githubController())
  app.route('/workspaces/:workspaceId', documentSourceController())
  app.route('/workspaces/:workspaceId', environmentController())
  app.route('/workspaces/:workspaceId', runnerPoolController())
  app.route('/workspaces/:workspaceId', bootstrapController())
  app.route('/workspaces/:workspaceId', boardScanController())
  // GitHub-facing (webhooks + setup callback); not workspace-scoped.
  app.route('/github', githubWebhookController())

  app.onError(handleError)

  return app
}
