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
import { promptFragmentController } from './modules/promptFragments/PromptFragmentController'

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
  // GitHub-facing (webhooks + setup callback); not workspace-scoped.
  app.route('/github', githubWebhookController())

  app.onError(handleError)

  return app
}
