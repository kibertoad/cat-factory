import type { Hono } from 'hono'
import type { AppEnv } from './http/env.js'
import { accountController } from './modules/accounts/AccountController.js'
import { agentRunController } from './modules/agentRuns/AgentRunController.js'
import { artifactController } from './modules/artifacts/ArtifactController.js'
import { harnessArtifactController } from './modules/artifacts/HarnessArtifactController.js'
import { authController } from './modules/auth/AuthController.js'
import { boardController } from './modules/board/BoardController.js'
import { bootstrapController } from './modules/bootstrap/BootstrapController.js'
import { documentSourceController } from './modules/documents/DocumentSourceController.js'
import { environmentController } from './modules/environments/EnvironmentController.js'
import { eventsController } from './modules/events/EventsController.js'
import { executionController } from './modules/execution/ExecutionController.js'
import { fragmentLibraryController } from './modules/fragmentLibrary/FragmentLibraryController.js'
import { githubController } from './modules/github/GitHubController.js'
import { githubWebhookController } from './modules/github/GitHubWebhookController.js'
import { vcsWebhookController } from './modules/vcs/VcsWebhookController.js'
import { llmProxyController } from './modules/llmProxy/LlmProxyController.js'
import { mergePresetController } from './modules/merge/MergePresetController.js'
import { sandboxController } from './modules/sandbox/SandboxController.js'
import { workspaceSettingsController } from './modules/settings/WorkspaceSettingsController.js'
import { localSettingsController } from './modules/localSettings/LocalSettingsController.js'
import { releaseHealthController } from './modules/releaseHealth/ReleaseHealthController.js'
import { incidentEnrichmentController } from './modules/incidentEnrichment/IncidentEnrichmentController.js'
import { modelPresetController } from './modules/modelPresets/ModelPresetController.js'
import { serviceFragmentDefaultsController } from './modules/serviceFragmentDefaults/ServiceFragmentDefaultsController.js'
import { modelController } from './modules/models/ModelController.js'
import { notificationController } from './modules/notifications/NotificationController.js'
import { pipelineController } from './modules/pipelines/PipelineController.js'
import { promptFragmentController } from './modules/promptFragments/PromptFragmentController.js'
import { recurringPipelineController } from './modules/recurring/RecurringPipelineController.js'
import { trackerSettingsController } from './modules/recurring/TrackerSettingsController.js'
import { requirementReviewController } from './modules/requirements/RequirementReviewController.js'
import { followUpController } from './modules/followUp/FollowUpController.js'
import { kaizenController } from './modules/kaizen/KaizenController.js'
import { humanTestController } from './modules/humanTest/HumanTestController.js'
import { visualConfirmationController } from './modules/visualConfirm/VisualConfirmationController.js'
import { humanReviewController } from './modules/humanReview/HumanReviewController.js'
import { consensusController } from './modules/consensus/ConsensusController.js'
import { clarityReviewController } from './modules/clarity/ClarityReviewController.js'
import { brainstormController } from './modules/brainstorm/BrainstormController.js'
import { webSearchProxyController } from './modules/webSearch/WebSearchProxyController.js'
import { runnerPoolController } from './modules/runners/RunnerPoolController.js'
import { provisioningLogController } from './modules/provisioningLogs/ProvisioningLogController.js'
import { slackController, slackOAuthController } from './modules/slack/SlackController.js'
import { vendorCredentialController } from './modules/providers/VendorCredentialController.js'
import { personalSubscriptionController } from './modules/providers/PersonalSubscriptionController.js'
import { localModelEndpointController } from './modules/localModels/LocalModelEndpointController.js'
import { userSecretController } from './modules/providers/UserSecretController.js'
import { openRouterCatalogController } from './modules/openrouter/OpenRouterCatalogController.js'
import {
  userApiKeyController,
  workspaceApiKeyController,
} from './modules/providers/ApiKeyController.js'
import { serviceMountController } from './modules/services/ServiceMountController.js'
import { serviceSpecController } from './modules/serviceSpec/ServiceSpecController.js'
import {
  linearOAuthController,
  taskSourceController,
} from './modules/tasks/TaskSourceController.js'
import { workspaceController } from './modules/workspaces/WorkspaceController.js'
import { persistenceController } from './modules/persistence/PersistenceController.js'

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
  // In-container screenshot ingest for the UI tester (same container session token as the
  // LLM proxy; reachable at `${proxyBaseUrl}/artifacts/ingest`). 503 when no blob storage.
  app.route('/', harnessArtifactController())
  // SearXNG-compatible web-search proxy for implementation containers (same
  // model-locked container token; the search runs server-side under the deployment's
  // own key via the `webSearch` gateway, so no provider key reaches the sandbox). A
  // no-op 503 when no upstream is wired.
  app.route('/', webSearchProxyController())
  // "Login with GitHub" (public; no-op endpoints when auth is unconfigured).
  app.route('/auth', authController())
  // Mothership-mode machine API (`/internal/persistence`): a mothership-mode local node with
  // no database forwards its org/durable repository calls here. Self-authenticated by a
  // machine token (NOT the user session gate, which bypasses `/internal`); 503 unless the
  // facade attached its repository registry. Mounted on both facades so either can be a
  // mothership.
  app.route('/', persistenceController())
  // Read-only catalogs + account/workspace roots (gated by the facade's auth middleware).
  app.route('/', promptFragmentController())
  app.route('/', modelController())
  app.route('/', accountController())
  app.route('/', personalSubscriptionController())
  app.route('/', localModelEndpointController())
  app.route('/', userSecretController())
  app.route('/', openRouterCatalogController())
  app.route('/', userApiKeyController())
  // Local-mode operational settings (warm pool + checkout reuse); 503 on non-local facades.
  app.route('/', localSettingsController())
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
  app.route('/workspaces/:workspaceId', provisioningLogController())
  app.route('/workspaces/:workspaceId', vendorCredentialController())
  app.route('/workspaces/:workspaceId', workspaceApiKeyController())
  app.route('/workspaces/:workspaceId', bootstrapController())
  app.route('/workspaces/:workspaceId', agentRunController())
  // Binary-artifact API (screenshots + reference uploads) for the visual-confirmation
  // gate; 503 when no blob storage is configured.
  app.route('/workspaces/:workspaceId', artifactController())
  app.route('/workspaces/:workspaceId', requirementReviewController())
  app.route('/workspaces/:workspaceId', followUpController())
  app.route('/workspaces/:workspaceId', kaizenController())
  app.route('/workspaces/:workspaceId', humanTestController())
  app.route('/workspaces/:workspaceId', visualConfirmationController())
  app.route('/workspaces/:workspaceId', humanReviewController())
  app.route('/workspaces/:workspaceId', consensusController())
  app.route('/workspaces/:workspaceId', clarityReviewController())
  app.route('/workspaces/:workspaceId', brainstormController())
  app.route('/workspaces/:workspaceId', notificationController())
  app.route('/workspaces/:workspaceId', mergePresetController())
  app.route('/workspaces/:workspaceId', sandboxController())
  app.route('/workspaces/:workspaceId', workspaceSettingsController())
  app.route('/workspaces/:workspaceId', releaseHealthController())
  app.route('/workspaces/:workspaceId', incidentEnrichmentController())
  app.route('/workspaces/:workspaceId', modelPresetController())
  app.route('/workspaces/:workspaceId', serviceFragmentDefaultsController())
  app.route('/workspaces/:workspaceId', recurringPipelineController())
  app.route('/workspaces/:workspaceId', trackerSettingsController())
  app.route('/workspaces/:workspaceId', serviceMountController())
  app.route('/workspaces/:workspaceId', serviceSpecController())
  app.route('/workspaces/:workspaceId', fragmentLibraryController('workspace'))
  app.route('/workspaces/:workspaceId', githubController())
  app.route('/workspaces/:workspaceId', slackController())
  // GitHub-facing (webhooks + setup callback); not workspace-scoped.
  app.route('/github', githubWebhookController())
  // Provider-neutral VCS webhook receiver (GitLab first); not workspace-scoped. GitHub keeps
  // its own route above; this serves any other provider registered in the VCS registry.
  app.route('/vcs', vcsWebhookController())
  // Slack-facing OAuth callback (browser redirect); not workspace-scoped.
  app.route('/slack', slackOAuthController())
  // Linear-facing OAuth callback (browser redirect); not workspace-scoped.
  app.route('/tasks', linearOAuthController())
}
