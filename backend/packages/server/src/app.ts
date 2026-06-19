import type { Hono } from 'hono'
import type { AppEnv } from './http/env'
import { accountController } from './modules/accounts/AccountController'
import { agentRunController } from './modules/agentRuns/AgentRunController'
import { authController } from './modules/auth/AuthController'
import { boardController } from './modules/board/BoardController'
import { boardScanController } from './modules/boardScan/BoardScanController'
import { bootstrapController } from './modules/bootstrap/BootstrapController'
import { documentSourceController } from './modules/documents/DocumentSourceController'
import { environmentController } from './modules/environments/EnvironmentController'
import { eventsController } from './modules/events/EventsController'
import { executionController } from './modules/execution/ExecutionController'
import { fragmentLibraryController } from './modules/fragmentLibrary/FragmentLibraryController'
import { githubController } from './modules/github/GitHubController'
import { githubWebhookController } from './modules/github/GitHubWebhookController'
import { mergePresetController } from './modules/merge/MergePresetController'
import { modelController } from './modules/models/ModelController'
import { notificationController } from './modules/notifications/NotificationController'
import { pipelineController } from './modules/pipelines/PipelineController'
import { promptFragmentController } from './modules/promptFragments/PromptFragmentController'
import { requirementReviewController } from './modules/requirements/RequirementReviewController'
import { runnerPoolController } from './modules/runners/RunnerPoolController'
import { taskSourceController } from './modules/tasks/TaskSourceController'
import { workspaceController } from './modules/workspaces/WorkspaceController'

/**
 * Mount the runtime-neutral controllers onto a facade's Hono app, preserving the
 * canonical mount prefixes. A facade (the Cloudflare Worker, the Node service)
 * creates its own app — adding CORS, the per-request container, the auth gate and
 * any runtime-specific controllers (events/webhooks/llm-proxy) — then calls this to
 * mount everything shared. The app's Env may extend {@link AppEnv} with runtime
 * `Bindings`; the controllers only touch `Variables` (`container`, `user`).
 */
export function registerCoreControllers<E extends AppEnv>(app: Hono<E>): void {
  // "Login with GitHub" (public; no-op endpoints when auth is unconfigured).
  app.route('/auth', authController())
  // Read-only catalogs + account/workspace roots (gated by the facade's auth middleware).
  app.route('/', promptFragmentController())
  app.route('/', modelController())
  app.route('/', accountController())
  app.route('/accounts/:accountId', fragmentLibraryController('account'))
  app.route('/', workspaceController())
  // Real-time WebSocket event stream (self-authenticates via ?ticket=; the facade's
  // gate bypasses only its exact upgrade shape). The upgrade is delegated to the
  // facade's realtime gateway.
  app.route('/', eventsController())
  // Per-workspace API.
  app.route('/workspaces/:workspaceId', boardController())
  app.route('/workspaces/:workspaceId', pipelineController())
  app.route('/workspaces/:workspaceId', executionController())
  app.route('/workspaces/:workspaceId', documentSourceController())
  app.route('/workspaces/:workspaceId', taskSourceController())
  app.route('/workspaces/:workspaceId', environmentController())
  app.route('/workspaces/:workspaceId', runnerPoolController())
  app.route('/workspaces/:workspaceId', bootstrapController())
  app.route('/workspaces/:workspaceId', agentRunController())
  app.route('/workspaces/:workspaceId', boardScanController())
  app.route('/workspaces/:workspaceId', requirementReviewController())
  app.route('/workspaces/:workspaceId', notificationController())
  app.route('/workspaces/:workspaceId', mergePresetController())
  app.route('/workspaces/:workspaceId', fragmentLibraryController('workspace'))
  app.route('/workspaces/:workspaceId', githubController())
  // GitHub-facing (webhooks + setup callback); not workspace-scoped.
  app.route('/github', githubWebhookController())
}
