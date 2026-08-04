import type { Hono } from 'hono'
import type { AppEnv } from './http/env.js'
import { accountController } from './modules/accounts/AccountController.js'
import { platformObservabilityController } from './modules/observability/PlatformObservabilityController.js'
import { reportsController } from './modules/reports/ReportsController.js'
import { agentRunController } from './modules/agentRuns/AgentRunController.js'
import { artifactController } from './modules/artifacts/ArtifactController.js'
import { harnessArtifactController } from './modules/artifacts/HarnessArtifactController.js'
import { authController } from './modules/auth/AuthController.js'
import { boardController } from './modules/board/BoardController.js'
import { bootstrapController } from './modules/bootstrap/BootstrapController.js'
import { documentSourceController } from './modules/documents/DocumentSourceController.js'
import { environmentController } from './modules/environments/EnvironmentController.js'
import { environmentUserHandlerController } from './modules/environments/EnvironmentUserHandlerController.js'
import { eventsController } from './modules/events/EventsController.js'
import { eventsRelayController } from './modules/events/EventsRelayController.js'
import { executionController } from './modules/execution/ExecutionController.js'
import { fragmentLibraryController } from './modules/fragmentLibrary/FragmentLibraryController.js'
import { foundationalServiceController } from './modules/foundationalServices/FoundationalServiceController.js'
import { skillLibraryController } from './modules/skillLibrary/SkillLibraryController.js'
import { githubController } from './modules/github/GitHubController.js'
import { gitlabController } from './modules/gitlab/GitLabController.js'
import { vcsConnectController } from './modules/vcs/VcsConnectController.js'
import { githubWebhookController } from './modules/github/GitHubWebhookController.js'
import { vcsWebhookController } from './modules/vcs/VcsWebhookController.js'
import { taskWebhookController } from './modules/tasks/TaskWebhookController.js'
import { llmProxyController } from './modules/llmProxy/LlmProxyController.js'
import { mergeTrackRecordController } from './modules/merge/MergeTrackRecordController.js'
import { riskPolicyController } from './modules/merge/RiskPolicyController.js'
import { sharedStackController } from './modules/sharedStack/SharedStackController.js'
import { preflightController } from './modules/preflight/PreflightController.js'
import { sandboxController } from './modules/sandbox/SandboxController.js'
import { workspaceSettingsController } from './modules/settings/WorkspaceSettingsController.js'
import { localSettingsController } from './modules/localSettings/LocalSettingsController.js'
import { mothershipConnectController } from './modules/localSettings/MothershipConnectController.js'
import { releaseHealthController } from './modules/releaseHealth/ReleaseHealthController.js'
import { testSecretsController } from './modules/testSecrets/TestSecretsController.js'
import { capabilityCredentialsController } from './modules/capabilityCredentials/CapabilityCredentialsController.js'
import { validationConfigController } from './modules/validation/ValidationConfigController.js'
import { packageRegistriesController } from './modules/packageRegistries/PackageRegistriesController.js'
import { previewController } from './modules/preview/PreviewController.js'
import { incidentEnrichmentController } from './modules/incidentEnrichment/IncidentEnrichmentController.js'
import { agentPromptController } from './modules/agentPrompts/AgentPromptController.js'
import { workspaceAgentSettingsController } from './modules/agentSettings/WorkspaceAgentSettingsController.js'
import { modelPresetController } from './modules/modelPresets/ModelPresetController.js'
import { serviceFragmentDefaultsController } from './modules/serviceFragmentDefaults/ServiceFragmentDefaultsController.js'
import { modelController } from './modules/models/ModelController.js'
import { notificationController } from './modules/notifications/NotificationController.js'
import { notificationRelayController } from './modules/notifications/NotificationRelayController.js'
import { telemetryIngestController } from './modules/telemetry/TelemetryIngestController.js'
import { telemetryReadController } from './modules/telemetry/TelemetryReadController.js'
import { pipelineController } from './modules/pipelines/PipelineController.js'
import { promptFragmentController } from './modules/promptFragments/PromptFragmentController.js'
import { recurringPipelineController } from './modules/recurring/RecurringPipelineController.js'
import { trackerSettingsController } from './modules/recurring/TrackerSettingsController.js'
import { requirementReviewController } from './modules/requirements/RequirementReviewController.js'
import { docInterviewController } from './modules/docInterview/DocInterviewController.js'
import { followUpController } from './modules/followUp/FollowUpController.js'
import { forkDecisionController } from './modules/forkDecision/ForkDecisionController.js'
import { inputGateController } from './modules/inputGate/InputGateController.js'
import { judgeController } from './modules/judge/JudgeController.js'
import { prReviewController } from './modules/prReview/PrReviewController.js'
import { kaizenController } from './modules/kaizen/KaizenController.js'
import { humanTestController } from './modules/humanTest/HumanTestController.js'
import { visualConfirmationController } from './modules/visualConfirm/VisualConfirmationController.js'
import { humanReviewController } from './modules/humanReview/HumanReviewController.js'
import { consensusController } from './modules/consensus/ConsensusController.js'
import { consensusGroupController } from './modules/consensus/ConsensusGroupController.js'
import { clarityReviewController } from './modules/clarity/ClarityReviewController.js'
import { brainstormController } from './modules/brainstorm/BrainstormController.js'
import { initiativeController } from './modules/initiatives/InitiativeController.js'
import { webSearchProxyController } from './modules/webSearch/WebSearchProxyController.js'
import { runnerPoolController } from './modules/runners/RunnerPoolController.js'
import { provisioningLogController } from './modules/provisioningLogs/ProvisioningLogController.js'
import { slackController, slackOAuthController } from './modules/slack/SlackController.js'
import { vendorCredentialController } from './modules/providers/VendorCredentialController.js'
import { personalSubscriptionController } from './modules/providers/PersonalSubscriptionController.js'
import { localModelEndpointController } from './modules/localModels/LocalModelEndpointController.js'
import { tutorialController } from './modules/tutorial/TutorialController.js'
import { userSettingsController } from './modules/userSettings/UserSettingsController.js'
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
import { bugHuntController } from './modules/bugHunt/BugHuntController.js'
import { workspaceController } from './modules/workspaces/WorkspaceController.js'
import { workspaceMemberController } from './modules/workspaces/WorkspaceMemberController.js'
import { persistenceController } from './modules/persistence/PersistenceController.js'
import { githubDelegationController } from './modules/persistence/GitHubDelegationController.js'
import { foundationalBuiltinsController } from './modules/foundationalServices/FoundationalBuiltinsController.js'
import { binaryGeneratorsController } from './modules/binaryGenerators/BinaryGeneratorsController.js'
import { publicApiController } from './modules/publicApi/PublicApiController.js'
import { publicApiKeyController } from './modules/publicApi/PublicApiKeyController.js'
import { publicDecisionController } from './modules/publicApi/PublicDecisionController.js'
import { publicDebugController } from './modules/publicApi/PublicDebugController.js'
import { publicNotificationWebhookController } from './modules/publicApi/PublicNotificationWebhookController.js'
import { notificationWebhookController } from './modules/notificationWebhook/NotificationWebhookController.js'

/**
 * Mount the runtime-neutral controllers onto a facade's Hono app, preserving the
 * canonical mount prefixes. A facade (the Cloudflare Worker, the Node service)
 * creates its own app — adding CORS, the per-request container, the auth gate and
 * any runtime-specific controllers (events/webhooks/llm-proxy) — then calls this to
 * mount everything shared. The app's Env may extend {@link AppEnv} with runtime
 * `Bindings`; the controllers only touch `Variables` (`container`, `user`).
 */
export function registerCoreControllers<E extends AppEnv>(app: Hono<E>): void {
  registerRootControllers(app)
  registerWorkspaceControllers(app)
  registerWebhookControllers(app)
}

/**
 * The controllers mounted at the app root (`/`): the container-facing harness endpoints, the
 * mothership-mode machine APIs, the public external API, and the read-only catalogs + account /
 * user / workspace roots. Mounted before the per-workspace API, so the order here is significant.
 */
function registerRootControllers<E extends AppEnv>(app: Hono<E>): void {
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
  // Mothership-mode GitHub delegation (`/internal/github/installation-token`): a mothership-mode
  // local node with no GitHub PAT mints its short-lived installation tokens here, so its agent
  // containers/gates/RepoFiles ops reach GitHub while the App private key stays on the
  // mothership. Machine-token gated like the persistence RPC; 503 unless the facade wired
  // `githubTokenDelegation`. Mounted on both facades so either can be a mothership.
  app.route('/', githubDelegationController())
  // Mothership-mode foundational-services `builtin` tier (`GET /internal/foundational-services`
  // + the batched `POST .../contracts`):
  // the catalog tier a deployment registers in CODE is org state, and a mothership-mode node has
  // no main database to hold it — so it reads the MOTHERSHIP's registry here rather than its own,
  // which would be a second copy silently drifting one build behind. Machine-token gated like the
  // persistence RPC; never 503s (an unregistered estate is legitimately empty). Mounted on both
  // facades so either can be a mothership. See backend/docs/adr/0031-foundational-services.md.
  app.route('/', foundationalBuiltinsController())
  // Mothership-mode GENERATIVE BINARY INTEGRATIONS (`/internal/binary-generators` + the batched
  // `POST .../contracts`): the same story as the tier above, one registry along. What a
  // deployment registers in code is what the pipeline builder's picker OFFERS, so a node
  // resolving its own copy refuses a step the product itself filled in. Machine-token gated;
  // never 503s (a deployment registering none is legitimately empty). Mounted on both facades so
  // either can be a mothership. See docs/initiatives/binary-output-foundational-storage.md.
  app.route('/', binaryGeneratorsController())
  // Mothership-mode real-time upstream (`/internal/events/publish`): a mothership-mode local node
  // POSTs its engine events here so the mothership's own realtime fan-out (hosted teammates on the
  // shared board) sees the local node's activity live. Machine-token gated like the persistence
  // RPC; 503 unless the facade wired `machineEventRelay`. Mounted on both facades so either can be
  // a mothership. See docs/initiatives/mothership-mode.md.
  app.route('/', eventsRelayController())
  // Mothership-mode notification DELIVERY (`/internal/notifications/deliver`): a mothership-mode
  // local node persists its notification rows remotely but holds none of the org's external
  // delivery credentials, so it asks the mothership to deliver a row (by id) through the org's
  // Slack. Machine-token gated like the persistence RPC; 503 unless the facade wired
  // `machineNotificationDelivery`. Mounted on both facades so either can be a mothership. See
  // docs/initiatives/mothership-mode.md.
  app.route('/', notificationRelayController())
  // Mothership-mode telemetry INGEST (`/internal/telemetry/ingest`): a mothership-mode local node
  // captures its run telemetry locally (product decision 5) and uploads a quiesced run's rows here
  // in bounded batches, so hosted teammates can read them and they outlive the node's short local
  // retention window. Machine-token gated like the persistence RPC; 503 unless the facade attached
  // its repository registry. Mounted on both facades so either can be a mothership. See
  // docs/initiatives/mothership-mode.md.
  app.route('/', telemetryIngestController())
  // Mothership-mode telemetry READ-THROUGH (`/internal/telemetry/read`): the dual of the ingest
  // above. A mothership-mode node whose LOCAL store holds no rows for a run — pruned, or driven
  // by someone else entirely — serves its observability, rollup and debug surfaces from the
  // mothership's copy through a closed table of BOUNDED reads, rather than rendering the empty
  // panel that reads as "this run spent nothing". Machine-token gated like the persistence RPC;
  // 503 unless the facade attached its repository registry. Mounted on both facades so either
  // can be a mothership. See docs/initiatives/mothership-mode.md.
  app.route('/', telemetryReadController())
  // The PUBLIC external API (`/api/v1/*`): key-authenticated in-controller (its `/api` prefix
  // bypasses the session gate), for external systems to run a public inline pipeline headlessly.
  app.route('/', publicApiController())
  // The public PARKED-DECISION surface (`/api/v1/runs/:runId/decisions/*`): the answerer that lets
  // a headless run include the clarification loop at all. Same in-controller key auth, gated on
  // the `decide` rung of the scope ladder. See docs/initiatives/headless-clarification-loop.md.
  app.route('/', publicDecisionController())
  // The public REMOTE DEBUGGING surface (`/api/v1/debug/*`): read-scoped, keyset-paginated reads
  // over a run's telemetry + provisioning log, sized so an LLM can walk them within a context
  // budget. See backend/docs/debug-api.md.
  app.route('/', publicDebugController())
  // The public OUTBOUND-WEBHOOK management surface (`/api/v1/notification-webhook`): the enrolment
  // half of the push channel, so a deployment with no browser session can register the receiver
  // its notifications, run-lifecycle edges and health alerts are delivered to. `admin` scope; same
  // service the session-authed `/workspaces/:ws/notification-webhook` routes call.
  app.route('/', publicNotificationWebhookController())
  // Read-only catalogs + account/workspace roots (gated by the facade's auth middleware).
  app.route('/', promptFragmentController())
  app.route('/', modelController())
  app.route('/', accountController())
  // Platform-operator observability (`/accounts/:id/observability/platform`); admin-gated,
  // 503 when the platform-metrics rollup isn't wired.
  app.route('/', platformObservabilityController())
  // Cross-cutting usage analytics (`/accounts/:id/reports`); admin-gated, 503 when the
  // reports rollup isn't wired.
  app.route('/', reportsController())
  app.route('/', personalSubscriptionController())
  app.route('/', localModelEndpointController())
  app.route('/', userSettingsController())
  // Per-USER tutorial progress + the funnel counters. Root-mounted beside user settings on
  // purpose: it is a fact about a person, not a board, and mounting it under `/workspaces/:ws/*`
  // would put it behind the RBAC viewer write floor that a viewer taking a walkthrough trips.
  app.route('/', tutorialController())
  // Per-user infra handler overrides (local mode); 503s where the service is unwired.
  app.route('/', environmentUserHandlerController())
  app.route('/', userSecretController())
  app.route('/', openRouterCatalogController())
  app.route('/', userApiKeyController())
  // Local-mode operational settings (warm pool + checkout reuse); 503 on non-local facades.
  app.route('/', localSettingsController())
  // Local-mode mothership login (`/local/mothership/connect`): exchanges a mothership session
  // for a cached machine token; 503 unless the local facade wired the connector.
  app.route('/', mothershipConnectController())
  app.route('/accounts/:accountId', fragmentLibraryController('account'))
  app.route('/accounts/:accountId', skillLibraryController())
  app.route('/accounts/:accountId', foundationalServiceController('account'))
  app.route('/', workspaceController())
  // Workspace-membership roster + access-mode management (workspace-rbac). Absolute
  // `/workspaces/:ws/members` + `/access-mode` paths (like the workspace root), so mounted at `/`;
  // 503 until the facade wires the workspace-member repository. Writes require `members.manage`.
  app.route('/', workspaceMemberController())
  // Real-time WebSocket event stream (self-authenticates via ?ticket=; the facade's
  // gate bypasses only its exact upgrade shape). The upgrade is delegated to the
  // facade's realtime gateway.
  app.route('/', eventsController())
}

/**
 * The per-workspace API — every controller mounted under `/workspaces/:workspaceId`. Order is
 * significant (shared middleware/routing), so it mirrors the historical registration order.
 *
 * Split into two ordered halves — the board / run / human-gate surfaces, then the workspace
 * CONFIGURATION surfaces (policies, secrets, presets, integrations) — purely for the
 * per-function statement budget. They are called back-to-back, so the mount order is
 * byte-for-byte what it was when this was one function.
 */
function registerWorkspaceControllers<E extends AppEnv>(app: Hono<E>): void {
  registerWorkspaceRunControllers(app)
  registerWorkspaceConfigControllers(app)
}

/**
 * The first half of the per-workspace API: the board, the run/execution surfaces, and every
 * human-gate window a parked run opens. Mounted before {@link registerWorkspaceConfigControllers}.
 */
function registerWorkspaceRunControllers<E extends AppEnv>(app: Hono<E>): void {
  // Per-workspace API.
  app.route('/workspaces/:workspaceId', boardController())
  app.route('/workspaces/:workspaceId', pipelineController())
  app.route('/workspaces/:workspaceId', executionController())
  app.route('/workspaces/:workspaceId', documentSourceController())
  app.route('/workspaces/:workspaceId', taskSourceController())
  app.route('/workspaces/:workspaceId', bugHuntController())
  app.route('/workspaces/:workspaceId', environmentController())
  app.route('/workspaces/:workspaceId', runnerPoolController())
  app.route('/workspaces/:workspaceId', provisioningLogController())
  app.route('/workspaces/:workspaceId', vendorCredentialController())
  app.route('/workspaces/:workspaceId', workspaceApiKeyController())
  app.route('/workspaces/:workspaceId', publicApiKeyController())
  // Outbound notification webhook: the endpoint a headless integration registers to be PUSHED the
  // workspace's notifications (chiefly a run parking on a human decision) instead of polling.
  app.route('/workspaces/:workspaceId', notificationWebhookController())
  app.route('/workspaces/:workspaceId', bootstrapController())
  app.route('/workspaces/:workspaceId', agentRunController())
  // Binary-artifact API (screenshots + reference uploads) for the visual-confirmation
  // gate; 503 when no blob storage is configured.
  app.route('/workspaces/:workspaceId', artifactController())
  app.route('/workspaces/:workspaceId', requirementReviewController())
  app.route('/workspaces/:workspaceId', docInterviewController())
  app.route('/workspaces/:workspaceId', followUpController())
  app.route('/workspaces/:workspaceId', forkDecisionController())
  app.route('/workspaces/:workspaceId', inputGateController())
  app.route('/workspaces/:workspaceId', judgeController())
  app.route('/workspaces/:workspaceId', prReviewController())
  app.route('/workspaces/:workspaceId', kaizenController())
  app.route('/workspaces/:workspaceId', humanTestController())
  app.route('/workspaces/:workspaceId', visualConfirmationController())
  app.route('/workspaces/:workspaceId', humanReviewController())
  app.route('/workspaces/:workspaceId', consensusController())
  app.route('/workspaces/:workspaceId', consensusGroupController())
  app.route('/workspaces/:workspaceId', clarityReviewController())
  app.route('/workspaces/:workspaceId', brainstormController())
  app.route('/workspaces/:workspaceId', initiativeController())
  app.route('/workspaces/:workspaceId', notificationController())
}

/**
 * The second half of the per-workspace API: the workspace's CONFIGURATION surfaces — merge and
 * risk policy, shared infra, secrets, presets, and the per-provider integrations. Mounted
 * immediately after {@link registerWorkspaceRunControllers}, preserving the historical order.
 */
function registerWorkspaceConfigControllers<E extends AppEnv>(app: Hono<E>): void {
  app.route('/workspaces/:workspaceId', riskPolicyController())
  app.route('/workspaces/:workspaceId', mergeTrackRecordController())
  app.route('/workspaces/:workspaceId', sharedStackController())
  app.route('/workspaces/:workspaceId', preflightController())
  app.route('/workspaces/:workspaceId', sandboxController())
  app.route('/workspaces/:workspaceId', workspaceSettingsController())
  app.route('/workspaces/:workspaceId', releaseHealthController())
  app.route('/workspaces/:workspaceId', testSecretsController())
  app.route('/workspaces/:workspaceId', capabilityCredentialsController())
  app.route('/workspaces/:workspaceId', validationConfigController())
  app.route('/workspaces/:workspaceId', packageRegistriesController())
  // Browsable frontend preview (local/node); 503 on the Worker (frontendPreview unsupported).
  app.route('/workspaces/:workspaceId', previewController())
  app.route('/workspaces/:workspaceId', incidentEnrichmentController())
  app.route('/workspaces/:workspaceId', modelPresetController())
  app.route('/workspaces/:workspaceId', agentPromptController())
  app.route('/workspaces/:workspaceId', workspaceAgentSettingsController())
  app.route('/workspaces/:workspaceId', serviceFragmentDefaultsController())
  app.route('/workspaces/:workspaceId', recurringPipelineController())
  app.route('/workspaces/:workspaceId', trackerSettingsController())
  app.route('/workspaces/:workspaceId', serviceMountController())
  app.route('/workspaces/:workspaceId', serviceSpecController())
  app.route('/workspaces/:workspaceId', fragmentLibraryController('workspace'))
  app.route('/workspaces/:workspaceId', foundationalServiceController('workspace'))
  app.route('/workspaces/:workspaceId', githubController())
  app.route('/workspaces/:workspaceId', gitlabController())
  app.route('/workspaces/:workspaceId', vcsConnectController())
  app.route('/workspaces/:workspaceId', slackController())
}

/**
 * The provider-facing webhook receivers + OAuth redirect callbacks (GitHub / VCS / Slack / Linear);
 * not workspace-scoped. Mounted last, after the workspace API.
 */
function registerWebhookControllers<E extends AppEnv>(app: Hono<E>): void {
  // GitHub-facing (webhooks + setup callback); not workspace-scoped.
  app.route('/github', githubWebhookController())
  // Provider-neutral VCS webhook receiver (GitLab first); not workspace-scoped. GitHub keeps
  // its own route above; this serves any other provider registered in the VCS registry.
  app.route('/vcs', vcsWebhookController())
  // Tracker-facing webhook receiver (Jira / Linear / GitHub Issues); not session-scoped. Unlike
  // the two VCS receivers this carries the WORKSPACE in its path, because a tracker delivery has
  // no installation id to resolve one from — see `TaskWebhookController`.
  app.route('/webhooks', taskWebhookController())
  // Slack-facing OAuth callback (browser redirect); not workspace-scoped.
  app.route('/slack', slackOAuthController())
  // Linear-facing OAuth callback (browser redirect); not workspace-scoped.
  app.route('/tasks', linearOAuthController())
}
