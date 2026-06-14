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
import { pipelineController } from './modules/pipelines/PipelineController'
import { workspaceController } from './modules/workspaces/WorkspaceController'
import { githubController } from './modules/github/GitHubController'
import { githubWebhookController } from './modules/github/GitHubWebhookController'
import { confluenceController } from './modules/confluence/ConfluenceController'
import { environmentController } from './modules/environments/EnvironmentController'
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

  // Read-only best-practice fragment catalog (public, build-static reference data).
  app.route('/', promptFragmentController())

  // Read-only model picker catalog (public; resolved to each model's active flavour).
  app.route('/', modelController())

  // OpenAI-compatible LLM proxy for implementation containers. Authenticated by a
  // signed, model-locked session token (not the workspace session), so it sits
  // outside requireAuth; it injects the real provider key and meters spend.
  app.route('/', llmProxyController())

  // "Login with GitHub" (public; no-op endpoints when auth is unconfigured).
  app.route('/auth', authController())

  // Gate the workspace-scoped API behind a valid session when auth is enabled.
  // A no-op otherwise, so local dev and the test suite are unaffected.
  app.use('/workspaces', requireAuth())
  app.use('/workspaces/*', requireAuth())

  // API layer — controllers grouped by module.
  app.route('/', workspaceController())
  app.route('/workspaces/:workspaceId', boardController())
  app.route('/workspaces/:workspaceId', pipelineController())
  app.route('/workspaces/:workspaceId', executionController())
  app.route('/workspaces/:workspaceId', githubController())
  app.route('/workspaces/:workspaceId', confluenceController())
  app.route('/workspaces/:workspaceId', environmentController())
  // GitHub-facing (webhooks + setup callback); not workspace-scoped.
  app.route('/github', githubWebhookController())

  app.onError(handleError)

  return app
}
