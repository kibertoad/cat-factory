import type { Hono } from 'hono'
import type { AppEnv } from './http/env.js'
import { appLoopback } from './http/loopback.js'
import { accountController } from './modules/accounts/AccountController.js'
import { platformObservabilityController } from './modules/observability/PlatformObservabilityController.js'
import { reportsController } from './modules/reports/ReportsController.js'
import { agentRunController } from './modules/agentRuns/AgentRunController.js'
import { artifactController } from './modules/artifacts/ArtifactController.js'
import { harnessArtifactController } from './modules/artifacts/HarnessArtifactController.js'
import { authController } from './modules/auth/AuthController.js'
import { boardController } from './modules/board/BoardController.js'
import { bootstrapController } from './modules/bootstrap/BootstrapController.js'
import {
  documentOAuthController,
  documentSourceController,
} from './modules/documents/DocumentSourceController.js'
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
import { mcpOAuthCompletionController } from './modules/toolServers/McpOAuthCompletionController.js'
import { toolServerController } from './modules/toolServers/ToolServerController.js'
import { validationConfigController } from './modules/validation/ValidationConfigController.js'
import { packageRegistriesController } from './modules/packageRegistries/PackageRegistriesController.js'
import { previewController } from './modules/preview/PreviewController.js'
import { incidentEnrichmentController } from './modules/incidentEnrichment/IncidentEnrichmentController.js'
import { agentPromptController } from './modules/agentPrompts/AgentPromptController.js'
import { workspaceAgentSettingsController } from './modules/agentSettings/WorkspaceAgentSettingsController.js'
import { taskTypeSuppressionController } from './modules/taskTypes/TaskTypeSuppressionController.js'
import { modelPresetController } from './modules/modelPresets/ModelPresetController.js'
import { serviceFragmentDefaultsController } from './modules/serviceFragmentDefaults/ServiceFragmentDefaultsController.js'
import { modelController } from './modules/models/ModelController.js'
import { notificationController } from './modules/notifications/NotificationController.js'
import { notificationSettingsController } from './modules/notifications/NotificationSettingsController.js'
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
import { secretDelegationController } from './modules/persistence/SecretDelegationController.js'
import { foundationalBuiltinsController } from './modules/foundationalServices/FoundationalBuiltinsController.js'
import { binaryGeneratorsController } from './modules/binaryGenerators/BinaryGeneratorsController.js'
import { promptFragmentsInternalController } from './modules/promptFragments/PromptFragmentsInternalController.js'
import { publicApiController } from './modules/publicApi/PublicApiController.js'
import { publicApiKeyController } from './modules/publicApi/PublicApiKeyController.js'
import { publicDecisionController } from './modules/publicApi/PublicDecisionController.js'
import { publicDebugController } from './modules/publicApi/PublicDebugController.js'
import { publicEvidenceController } from './modules/publicApi/PublicEvidenceController.js'
import { publicDiscoveryController } from './modules/publicApi/PublicDiscoveryController.js'
import { publicKeyController } from './modules/publicApi/PublicKeyController.js'
import { publicMcpController } from './modules/publicApi/PublicMcpController.js'
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
  registerControllers(app, WORKSPACE_CONTROLLERS)
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
  // In-container screenshot ingest for the UI tester plus the reference-design download its
  // job body's manifest names (same container session token as the LLM proxy; reachable at
  // `${proxyBaseUrl}/artifacts/ingest` and `${proxyBaseUrl}/artifacts/reference/:id`). 503
  // when no blob storage.
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
  // Mothership-mode SECRET DELEGATION (`/internal/secrets/{unseal,seal}`): the key split that
  // keeps the mothership's `ENCRYPTION_KEY` off a laptop also leaves the laptop unable to open the
  // org credentials it must USE (a provisioned environment's access handle, an infra handler's
  // secret bundle, a release-health connection. The node names the ROW (never the ciphertext) and
  // the mothership re-reads it, scope-checks it and opens it under its own key; the seal half
  // keeps a secret the NODE produces readable by the org. Machine-token gated like the persistence
  // RPC; 503 unless the facade wired `secretCipherFor`, which it does only when it holds its own
  // main database and so is AUTHORITATIVE for the rows (a mothership-mode node holds only a local
  // key). Mounted on both facades so either can be a mothership. See
  // docs/initiatives/mothership-mode.md.
  app.route('/', secretDelegationController())
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
  // Mothership-mode PROMPT-FRAGMENT pool (`GET /internal/prompt-fragments`): the third registry of
  // the same family. The deployment's best-practice standards, and the per-task-type default sets
  // that select them, are CODE a RUN resolves, so a node reading its own copy folds different
  // guidance than the mothership's build has. Both projections ride one response. Machine-token
  // gated; never 503s (a deployment registering none is legitimately empty). Mounted on both
  // facades so either can be a mothership.
  app.route('/', promptFragmentsInternalController())
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
  // the `decide` rung of the scope ladder. See backend/docs/adr/0047-headless-clarification-loop.md.
  app.route('/', publicDecisionController())
  // The public REMOTE DEBUGGING surface (`/api/v1/debug/*`): read-scoped, keyset-paginated reads
  // over a run's telemetry + provisioning log, sized so an LLM can walk them within a context
  // budget. See backend/docs/debug-api.md.
  app.route('/', publicDebugController())
  // The public run-EVIDENCE surface (`/api/v1/runs/:runId/report`, `…/artifacts`, and the bytes
  // at `/api/v1/artifacts/:id/blob`): read-scoped access to the engine's own verification report
  // and the artifacts a run captured, for a consumer whose job is to JUDGE the run rather than
  // debug it. See backend/docs/public-api.md.
  app.route('/', publicEvidenceController())
  // HEADLESS key provisioning (`/api/v1/keys`): the external counterpart of the session-authed
  // key panel, `admin` scope, bounded so a minted key can never mint another and revoking a key
  // revokes what it minted.
  app.route('/', publicKeyController())
  // The public OUTBOUND-WEBHOOK management surface (`/api/v1/notification-webhook`): the enrolment
  // half of the push channel, so a deployment with no browser session can register the receiver
  // its notifications, run-lifecycle edges and health alerts are delivered to. `admin` scope; same
  // service the session-authed `/workspaces/:ws/notification-webhook` routes call.
  app.route('/', publicNotificationWebhookController())
  // DISCOVERY (`/api/v1/me`, `/api/v1/openapi.json`): what the calling key may do, and this
  // deployment's own copy of the spec — the two reads an integration makes before anything else,
  // each of which used to be answerable only by guessing. `read` scope, the floor of the ladder.
  app.route('/', publicDiscoveryController())
  // The public API spoken as MCP (`POST /api/v1/mcp`), so a host drives this deployment with no npm
  // install and no local process. Mounted LAST of the `/api/v1` surface it re-enters: same key auth,
  // and the tools reach those routes back through this app's own loopback under the caller's key, so
  // nothing here can drift from the surface above it.
  app.route('/', publicMcpController(appLoopback(app)))
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
  // Finishes an MCP tool-server OAuth grant from the `code`/`state` the SPA carries back off the
  // vendor's redirect. Root-mounted because the board is sealed into the state rather than named in
  // the path, and session-gated by the shared default-deny gate like everything else here, which
  // is what makes its user binding and `secrets.manage` re-check enforceable at all.
  app.route('/', mcpOAuthCompletionController())
  app.route('/', openRouterCatalogController())
  app.route('/', userApiKeyController())
  // Local-mode operational settings (warm pool + checkout reuse); 503 on non-local facades.
  app.route('/', localSettingsController())
  // Local-mode mothership login (`/local/mothership/connect`): exchanges a mothership session
  // for a cached machine token; 503 unless the local facade wired the connector.
  app.route('/', mothershipConnectController())
  registerControllers(app, ACCOUNT_CONTROLLERS)
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

/** The shared per-workspace mount prefix; every entry in {@link WORKSPACE_CONTROLLERS} hangs off it. */
export const WORKSPACE_MOUNT = '/workspaces/:workspaceId'
/** The shared per-account mount prefix. */
export const ACCOUNT_MOUNT = '/accounts/:accountId'

/** One controller and the shared prefix it mounts under. */
interface ControllerEntry {
  /** Short name, so a guard test can say WHICH controller broke an invariant. */
  name: string
  mount: typeof WORKSPACE_MOUNT | typeof ACCOUNT_MOUNT
  build: () => Hono<AppEnv>
}

/**
 * The per-workspace API, in registration order.
 *
 * ORDER IS SIGNIFICANT, and this list is the only statement of it: Hono composes a request from
 * every matching entry in the order they were registered, so a controller's middleware also runs
 * for routes registered after it. That is not merely a routing detail. Until each permission gate
 * was narrowed to its own controller's path prefixes, the admin `use('*')` mounts in here reached
 * every sibling below them, and a plain member was refused the human-gate writes (the story is on
 * `mountWorkspacePermission`; `http/permissionMounts.test.ts` drives this list to pin it).
 *
 * A list rather than a run of `app.route` calls so that the guard test judges exactly what the app
 * mounts: a controller added here is covered by construction, where one added by hand beside the
 * loop below would not be.
 */
export const WORKSPACE_CONTROLLERS: readonly ControllerEntry[] = [
  { name: 'board', mount: WORKSPACE_MOUNT, build: () => boardController() },
  { name: 'pipeline', mount: WORKSPACE_MOUNT, build: () => pipelineController() },
  { name: 'execution', mount: WORKSPACE_MOUNT, build: () => executionController() },
  { name: 'documentSource', mount: WORKSPACE_MOUNT, build: () => documentSourceController() },
  { name: 'taskSource', mount: WORKSPACE_MOUNT, build: () => taskSourceController() },
  { name: 'bugHunt', mount: WORKSPACE_MOUNT, build: () => bugHuntController() },
  { name: 'environment', mount: WORKSPACE_MOUNT, build: () => environmentController() },
  { name: 'runnerPool', mount: WORKSPACE_MOUNT, build: () => runnerPoolController() },
  { name: 'provisioningLog', mount: WORKSPACE_MOUNT, build: () => provisioningLogController() },
  { name: 'vendorCredential', mount: WORKSPACE_MOUNT, build: () => vendorCredentialController() },
  { name: 'workspaceApiKey', mount: WORKSPACE_MOUNT, build: () => workspaceApiKeyController() },
  { name: 'publicApiKey', mount: WORKSPACE_MOUNT, build: () => publicApiKeyController() },
  // Outbound notification webhook: the endpoint a headless integration registers to be PUSHED the
  // workspace's notifications (chiefly a run parking on a human decision) instead of polling.
  {
    name: 'notificationWebhook',
    mount: WORKSPACE_MOUNT,
    build: () => notificationWebhookController(),
  },
  { name: 'bootstrap', mount: WORKSPACE_MOUNT, build: () => bootstrapController() },
  { name: 'agentRun', mount: WORKSPACE_MOUNT, build: () => agentRunController() },
  // Binary-artifact API (screenshots + reference uploads) for the visual-confirmation
  // gate; 503 when no blob storage is configured.
  { name: 'artifact', mount: WORKSPACE_MOUNT, build: () => artifactController() },
  { name: 'requirementReview', mount: WORKSPACE_MOUNT, build: () => requirementReviewController() },
  { name: 'docInterview', mount: WORKSPACE_MOUNT, build: () => docInterviewController() },
  { name: 'followUp', mount: WORKSPACE_MOUNT, build: () => followUpController() },
  { name: 'forkDecision', mount: WORKSPACE_MOUNT, build: () => forkDecisionController() },
  { name: 'inputGate', mount: WORKSPACE_MOUNT, build: () => inputGateController() },
  { name: 'judge', mount: WORKSPACE_MOUNT, build: () => judgeController() },
  { name: 'prReview', mount: WORKSPACE_MOUNT, build: () => prReviewController() },
  { name: 'kaizen', mount: WORKSPACE_MOUNT, build: () => kaizenController() },
  { name: 'humanTest', mount: WORKSPACE_MOUNT, build: () => humanTestController() },
  {
    name: 'visualConfirmation',
    mount: WORKSPACE_MOUNT,
    build: () => visualConfirmationController(),
  },
  { name: 'humanReview', mount: WORKSPACE_MOUNT, build: () => humanReviewController() },
  { name: 'consensus', mount: WORKSPACE_MOUNT, build: () => consensusController() },
  { name: 'consensusGroup', mount: WORKSPACE_MOUNT, build: () => consensusGroupController() },
  { name: 'clarityReview', mount: WORKSPACE_MOUNT, build: () => clarityReviewController() },
  { name: 'brainstorm', mount: WORKSPACE_MOUNT, build: () => brainstormController() },
  { name: 'initiative', mount: WORKSPACE_MOUNT, build: () => initiativeController() },
  { name: 'notification', mount: WORKSPACE_MOUNT, build: () => notificationController() },
  // ---- the workspace CONFIGURATION surfaces (policies, secrets, presets, integrations) ----
  {
    name: 'notificationSettings',
    mount: WORKSPACE_MOUNT,
    build: () => notificationSettingsController(),
  },
  { name: 'riskPolicy', mount: WORKSPACE_MOUNT, build: () => riskPolicyController() },
  { name: 'mergeTrackRecord', mount: WORKSPACE_MOUNT, build: () => mergeTrackRecordController() },
  { name: 'sharedStack', mount: WORKSPACE_MOUNT, build: () => sharedStackController() },
  { name: 'preflight', mount: WORKSPACE_MOUNT, build: () => preflightController() },
  { name: 'sandbox', mount: WORKSPACE_MOUNT, build: () => sandboxController() },
  { name: 'workspaceSettings', mount: WORKSPACE_MOUNT, build: () => workspaceSettingsController() },
  { name: 'releaseHealth', mount: WORKSPACE_MOUNT, build: () => releaseHealthController() },
  { name: 'testSecrets', mount: WORKSPACE_MOUNT, build: () => testSecretsController() },
  {
    name: 'capabilityCredentials',
    mount: WORKSPACE_MOUNT,
    build: () => capabilityCredentialsController(),
  },
  { name: 'toolServer', mount: WORKSPACE_MOUNT, build: () => toolServerController() },
  { name: 'validationConfig', mount: WORKSPACE_MOUNT, build: () => validationConfigController() },
  { name: 'packageRegistries', mount: WORKSPACE_MOUNT, build: () => packageRegistriesController() },
  // Browsable frontend preview (local/node); 503 on the Worker (frontendPreview unsupported).
  { name: 'preview', mount: WORKSPACE_MOUNT, build: () => previewController() },
  {
    name: 'incidentEnrichment',
    mount: WORKSPACE_MOUNT,
    build: () => incidentEnrichmentController(),
  },
  { name: 'modelPreset', mount: WORKSPACE_MOUNT, build: () => modelPresetController() },
  { name: 'agentPrompt', mount: WORKSPACE_MOUNT, build: () => agentPromptController() },
  {
    name: 'workspaceAgentSettings',
    mount: WORKSPACE_MOUNT,
    build: () => workspaceAgentSettingsController(),
  },
  {
    name: 'taskTypeSuppression',
    mount: WORKSPACE_MOUNT,
    build: () => taskTypeSuppressionController(),
  },
  {
    name: 'serviceFragmentDefaults',
    mount: WORKSPACE_MOUNT,
    build: () => serviceFragmentDefaultsController(),
  },
  { name: 'recurringPipeline', mount: WORKSPACE_MOUNT, build: () => recurringPipelineController() },
  { name: 'trackerSettings', mount: WORKSPACE_MOUNT, build: () => trackerSettingsController() },
  { name: 'serviceMount', mount: WORKSPACE_MOUNT, build: () => serviceMountController() },
  { name: 'serviceSpec', mount: WORKSPACE_MOUNT, build: () => serviceSpecController() },
  {
    name: 'fragmentLibrary',
    mount: WORKSPACE_MOUNT,
    build: () => fragmentLibraryController('workspace'),
  },
  {
    name: 'foundationalService',
    mount: WORKSPACE_MOUNT,
    build: () => foundationalServiceController('workspace'),
  },
  { name: 'github', mount: WORKSPACE_MOUNT, build: () => githubController() },
  { name: 'gitlab', mount: WORKSPACE_MOUNT, build: () => gitlabController() },
  { name: 'vcsConnect', mount: WORKSPACE_MOUNT, build: () => vcsConnectController() },
  { name: 'slack', mount: WORKSPACE_MOUNT, build: () => slackController() },
]

/** The per-account API, in registration order (the account tiers of the two library surfaces). */
export const ACCOUNT_CONTROLLERS: readonly ControllerEntry[] = [
  {
    name: 'fragmentLibrary',
    mount: ACCOUNT_MOUNT,
    build: () => fragmentLibraryController('account'),
  },
  { name: 'skillLibrary', mount: ACCOUNT_MOUNT, build: () => skillLibraryController() },
  {
    name: 'foundationalService',
    mount: ACCOUNT_MOUNT,
    build: () => foundationalServiceController('account'),
  },
]

/** Mount every controller in `entries` on its own shared prefix, preserving list order. */
function registerControllers<E extends AppEnv>(
  app: Hono<E>,
  entries: readonly ControllerEntry[],
): void {
  for (const entry of entries) app.route(entry.mount, entry.build())
}

/** One provider-facing receiver and the ROOT prefix it mounts under. */
interface PublicControllerEntry {
  /** Short name, so a guard test can say WHICH receiver broke an invariant. */
  name: string
  /**
   * The root-level mount. Every value here MUST also appear in `authGate`'s `PUBLIC_PREFIXES`:
   * these receivers authenticate themselves (an HMAC signature over the raw body, a signed
   * `state`) and their callers carry no session, so one missing from that list is unreachable
   * rather than merely gated.
   */
  mount: string
  build: () => Hono<AppEnv>
}

/**
 * The provider-facing webhook receivers + OAuth redirect callbacks, in registration order; not
 * workspace-scoped, and mounted last, after the workspace API.
 *
 * A list rather than a run of `app.route` calls for the same reason {@link WORKSPACE_CONTROLLERS}
 * is one: it lets a guard test judge exactly what the app mounts. Here the invariant is the
 * session gate's public allowlist, and the failure it catches is a silent one — a receiver added
 * by hand beside a loop looks correct at its own mount and only ever fails against the live
 * vendor, as a 401 on a redirect nobody can retry. `http/publicPrefixes.test.ts` drives this list.
 *
 * The MCP tool-server OAuth flow deliberately has NO entry here: a vendor redirects the operator's
 * browser to the SPA, which re-presents the `code` and `state` over the authenticated API
 * (`mcpOAuthCompletionController`, mounted with the session-gated controllers above). A public
 * receiver could not tell WHO was completing the grant, since a third-party navigation carries no
 * bearer token.
 */
export const PROVIDER_CALLBACK_CONTROLLERS: readonly PublicControllerEntry[] = [
  // GitHub-facing (webhooks + setup callback).
  { name: 'githubWebhook', mount: '/github', build: () => githubWebhookController() },
  // Provider-neutral VCS webhook receiver (GitLab first). GitHub keeps its own route above; this
  // serves any other provider registered in the VCS registry.
  { name: 'vcsWebhook', mount: '/vcs', build: () => vcsWebhookController() },
  // Tracker-facing webhook receiver (Jira / Linear / GitHub Issues). Unlike the two VCS receivers
  // this carries the WORKSPACE in its path, because a tracker delivery has no installation id to
  // resolve one from — see `TaskWebhookController`.
  { name: 'taskWebhook', mount: '/webhooks', build: () => taskWebhookController() },
  // Slack-facing OAuth callback (browser redirect).
  { name: 'slackOAuth', mount: '/slack', build: () => slackOAuthController() },
  // Linear-facing OAuth callback (browser redirect).
  { name: 'linearOAuth', mount: '/tasks', build: () => linearOAuthController() },
  // Document-source OAuth callback (browser redirect). ONE receiver for every OAuth-capable
  // source — the source rides the signed `state`, because a deployment registers one redirect URL
  // per vendor app and the path cannot vary per source.
  { name: 'documentOAuth', mount: '/documents', build: () => documentOAuthController() },
]

function registerWebhookControllers<E extends AppEnv>(app: Hono<E>): void {
  for (const entry of PROVIDER_CALLBACK_CONTROLLERS) app.route(entry.mount, entry.build())
}
