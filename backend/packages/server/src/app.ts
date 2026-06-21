import type { Hono } from 'hono'
import type { AppEnv } from './http/env.js'
import { accountController } from './modules/accounts/AccountController.js'
import { agentRunController } from './modules/agentRuns/AgentRunController.js'
import { authController } from './modules/auth/AuthController.js'
import { boardController } from './modules/board/BoardController.js'
import { boardScanController } from './modules/boardScan/BoardScanController.js'
import { bootstrapController } from './modules/bootstrap/BootstrapController.js'
import { documentSourceController } from './modules/documents/DocumentSourceController.js'
import { environmentController } from './modules/environments/EnvironmentController.js'
import { eventsController } from './modules/events/EventsController.js'
import { executionController } from './modules/execution/ExecutionController.js'
import { fragmentLibraryController } from './modules/fragmentLibrary/FragmentLibraryController.js'
import { githubController } from './modules/github/GitHubController.js'
import { githubWebhookController } from './modules/github/GitHubWebhookController.js'
import { llmProxyController } from './modules/llmProxy/LlmProxyController.js'
import { mergePresetController } from './modules/merge/MergePresetController.js'
import { modelDefaultsController } from './modules/modelDefaults/ModelDefaultsController.js'
import { modelController } from './modules/models/ModelController.js'
import { notificationController } from './modules/notifications/NotificationController.js'
import { pipelineController } from './modules/pipelines/PipelineController.js'
import { promptFragmentController } from './modules/promptFragments/PromptFragmentController.js'
import { recurringPipelineController } from './modules/recurring/RecurringPipelineController.js'
import { trackerSettingsController } from './modules/recurring/TrackerSettingsController.js'
import { requirementReviewController } from './modules/requirements/RequirementReviewController.js'
import { webSearchProxyController } from './modules/webSearch/WebSearchProxyController.js'
import { runnerPoolController } from './modules/runners/RunnerPoolController.js'
import { vendorCredentialController } from './modules/providers/VendorCredentialController.js'
import { serviceMountController } from './modules/services/ServiceMountController.js'
import { taskSourceController } from './modules/tasks/TaskSourceController.js'
import { workspaceController } from './modules/workspaces/WorkspaceController.js'

/**
 * Mount the runtime-neutral controllers onto a facade's Hono app, preserving the
 * canonical mount prefixes. A facade (the Cloudflare Worker, the Node service)
 * creates its own app — adding CORS, the per-request container, the auth gate and
 * any runtime-specific controllers (events/webhooks/llm-proxy) — then calls this to
 * mount everything shared. The app's Env may extend {@link AppEnv} with runtime
 * `Bindings`; the controllers only touch `Variables` (`container`, `user`).
 */
export function registerCoreControllers<E extends AppEnv>(app: Hono<E>): void {
  // OpenAI-compatible LLM proxy for implementation containers (authenticated by a
  // signed, model-locked container token; upstream/in-process via the llmUpstream gateway).
  app.route('/', llmProxyController())
  // SearXNG-compatible web-search proxy for implementation containers (same
  // model-locked container token; the search runs server-side under the deployment's
  // own key via the `webSearch` gateway, so no provider key reaches the sandbox). A
  // no-op 503 when no upstream is wired.
  app.route('/', webSearchProxyController())
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
  app.route('/workspaces/:workspaceId', vendorCredentialController())
  app.route('/workspaces/:workspaceId', bootstrapController())
  app.route('/workspaces/:workspaceId', agentRunController())
  app.route('/workspaces/:workspaceId', boardScanController())
  app.route('/workspaces/:workspaceId', requirementReviewController())
  app.route('/workspaces/:workspaceId', notificationController())
  app.route('/workspaces/:workspaceId', mergePresetController())
  app.route('/workspaces/:workspaceId', modelDefaultsController())
  app.route('/workspaces/:workspaceId', recurringPipelineController())
  app.route('/workspaces/:workspaceId', trackerSettingsController())
  app.route('/workspaces/:workspaceId', serviceMountController())
  app.route('/workspaces/:workspaceId', fragmentLibraryController('workspace'))
  app.route('/workspaces/:workspaceId', githubController())
  // GitHub-facing (webhooks + setup callback); not workspace-scoped.
  app.route('/github', githubWebhookController())
}
