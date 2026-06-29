// Public surface of the external-system integration layer.

export {
  GitHubInstallationService,
  type GitHubInstallationServiceDependencies,
} from './modules/github/GitHubInstallationService.js'
export { GitHubService, type GitHubServiceDependencies } from './modules/github/GitHubService.js'
export {
  GitHubSyncService,
  type GitHubSyncServiceDependencies,
} from './modules/github/GitHubSyncService.js'
export { WebhookService, type WebhookServiceDependencies } from './modules/github/WebhookService.js'
export * as githubProjection from './modules/github/projection.logic.js'
export {
  RepoProvisioningService,
  type RepoProvisioningServiceDependencies,
  type DelegationReason,
  type ProvisionResult,
} from './modules/github/RepoProvisioningService.js'
export { canCreateRepo } from './modules/github/provisioning.logic.js'

export {
  DocumentConnectionService,
  type DocumentConnectionServiceDependencies,
} from './modules/documents/DocumentConnectionService.js'
export {
  DocumentContentResolverService,
  type DocumentContentResolverServiceDependencies,
} from './modules/documents/DocumentContentResolverService.js'
export {
  DocumentImportService,
  type DocumentImportServiceDependencies,
  toSourceDocument,
} from './modules/documents/DocumentImportService.js'
export {
  DocumentPlannerService,
  type DocumentPlannerServiceDependencies,
} from './modules/documents/DocumentPlannerService.js'
export {
  DocumentLinkService,
  type DocumentLinkServiceDependencies,
  type SpawnResult,
} from './modules/documents/DocumentLinkService.js'
export { MapDocumentSourceRegistry } from './modules/documents/documents.logic.js'
export * as documentsLogic from './modules/documents/documents.logic.js'
export * as confluenceLogic from './modules/documents/confluence.logic.js'
export * as notionLogic from './modules/documents/notion.logic.js'
export * as githubDocsLogic from './modules/documents/github-docs.logic.js'
export * as figmaLogic from './modules/documents/figma.logic.js'
export * as claudeDesignLogic from './modules/documents/claudeDesign.logic.js'
export { CONFLUENCE_DESCRIPTOR } from './modules/documents/confluence.logic.js'
export { NOTION_DESCRIPTOR } from './modules/documents/notion.logic.js'
export { GITHUB_DOCS_DESCRIPTOR } from './modules/documents/github-docs.logic.js'
export { FIGMA_DESCRIPTOR } from './modules/documents/figma.logic.js'
export { CLAUDE_DESIGN_DESCRIPTOR } from './modules/documents/claudeDesign.logic.js'
// Shared host-pinned HTTP helpers reused by the fixed-host document providers.
export {
  DocumentHttpError,
  assertHostPinned,
  createHostPinnedFetch,
  readCappedText as readCappedDocumentText,
} from './modules/documents/http.js'
// Document-source provider classes (thin `fetch` shells around the logic above).
// Promoted from the Worker infra so every facade composes the same providers.
export { ConfluenceProvider, ConfluenceApiError } from './modules/documents/ConfluenceProvider.js'
export { NotionProvider, NotionApiError } from './modules/documents/NotionProvider.js'
export { GitHubDocsProvider } from './modules/documents/GitHubDocsProvider.js'
export { FigmaProvider, FigmaApiError } from './modules/documents/FigmaProvider.js'
export { ClaudeDesignProvider } from './modules/documents/ClaudeDesignProvider.js'
export { LinearDocumentProvider } from './modules/documents/LinearDocumentProvider.js'
export * as linearDocsLogic from './modules/documents/linear-docs.logic.js'
export { LINEAR_DOCS_DESCRIPTOR } from './modules/documents/linear-docs.logic.js'
// The shared Linear GraphQL transport (host-pinned, OAuth-ready) every Linear
// consumer — the document + task sources, ticket filing and PR writeback — uses.
export {
  LinearGraphqlClient,
  LinearApiError,
  LINEAR_GRAPHQL_URL,
  linearAuthHeader,
  linearAuthFromCredentials,
  unwrapLinearData,
  type LinearAuth,
  type LinearFetchLike,
} from './modules/shared/linear.client.js'

export {
  TaskConnectionService,
  type TaskConnectionServiceDependencies,
} from './modules/tasks/TaskConnectionService.js'
export {
  TaskImportService,
  type TaskImportServiceDependencies,
  toSourceTask,
} from './modules/tasks/TaskImportService.js'
export {
  TaskLinkService,
  type TaskLinkServiceDependencies,
} from './modules/tasks/TaskLinkService.js'
export {
  MapTaskSourceRegistry,
  type TaskContextView,
  renderTaskContext,
  buildTaskExcerpt,
} from './modules/tasks/tasks.logic.js'
export * as tasksLogic from './modules/tasks/tasks.logic.js'
export * as jiraLogic from './modules/tasks/jira.logic.js'
export { JIRA_DESCRIPTOR } from './modules/tasks/jira.logic.js'
export * as linearTasksLogic from './modules/tasks/linear.logic.js'
export { LINEAR_TASK_DESCRIPTOR } from './modules/tasks/linear.logic.js'
export { LinearTaskProvider } from './modules/tasks/LinearTaskProvider.js'
export {
  TicketTrackerService,
  type TicketTrackerServiceDependencies,
  type JiraConnection,
  type LinearConnection,
  type FetchLike,
} from './modules/tracker/TicketTrackerService.js'
export * as jiraCreateLogic from './modules/tracker/jira.create.logic.js'
export * as jiraWritebackLogic from './modules/tracker/jira.writeback.logic.js'
export * as linearCreateLogic from './modules/tracker/linear.create.logic.js'
export * as linearWritebackLogic from './modules/tracker/linear.writeback.logic.js'
export { extractReferences, type ExtractedReferences } from './modules/corpus/references.logic.js'
export {
  IssueWritebackService,
  type IssueWritebackServiceDependencies,
} from './modules/writeback/IssueWritebackService.js'
export {
  createGitHubIssueViaToken,
  type GitHubIssueTokenRequest,
} from './modules/tracker/github.create.logic.js'
export * as githubIssuesLogic from './modules/tasks/github-issues.logic.js'
export { GITHUB_ISSUES_DESCRIPTOR } from './modules/tasks/github-issues.logic.js'
export {
  GitHubIssuesProvider,
  type GitHubIssuesProviderDependencies,
} from './modules/tasks/GitHubIssuesProvider.js'
// The Jira task-source provider (a thin `fetch` shell around the pure Jira logic):
// runtime-neutral, so both facades compose the SAME class instead of a per-runtime copy.
export { JiraProvider, JiraApiError } from './modules/tasks/JiraProvider.js'

export {
  EnvironmentConnectionService,
  type EnvironmentConnectionServiceDependencies,
  type ConfigRepairDispatch,
  type ResolvedConnection,
} from './modules/environments/EnvironmentConnectionService.js'
// The ephemeral-environment backend provider-registry seam: maps a backend kind
// (`manifest` | `kubernetes` | future `nomad`/…) → an EnvironmentProvider. Built-ins
// self-register on import; a third-party kind registers via `registerEnvironmentBackend`.
export {
  registerEnvironmentBackend,
  environmentBackend,
  registeredEnvironmentBackendKinds,
  findRepairCapableProvider,
  manifestEnvironmentBackend,
  kubernetesEnvironmentBackend,
  type EnvironmentBackendProvider,
  type EnvironmentBackendContext,
  type EnvironmentBackendSafetyOptions,
} from './modules/environments/environment-backends.js'
export {
  EnvironmentProvisioningService,
  type EnvironmentProvisioningServiceDependencies,
  type ProvisionArgs,
  type ResolvedEnvironment,
} from './modules/environments/EnvironmentProvisioningService.js'
export {
  EnvironmentTeardownService,
  type EnvironmentTeardownServiceDependencies,
} from './modules/environments/EnvironmentTeardownService.js'
export * as environmentsLogic from './modules/environments/environments.logic.js'
// The HTTP environment provider (a `fetch` shell around the manifest logic above),
// promoted from the Worker infra so every facade composes the same provider.
export {
  HttpEnvironmentProvider,
  EnvironmentApiError,
} from './modules/environments/HttpEnvironmentProvider.js'
export {
  isDeployStep,
  DEPLOYER_AGENT_KIND,
  ENVIRONMENT_BLOCK_TYPE,
} from './modules/environments/environments.logic.js'

export {
  RunnerPoolConnectionService,
  type RunnerPoolConnectionServiceDependencies,
  type ResolvedRunnerBackend,
} from './modules/runners/RunnerPoolConnectionService.js'
export * as runnersLogic from './modules/runners/runners.logic.js'
// The universal "agent runner backend" provider-registry seam: maps a backend kind
// (`manifest` | `kubernetes` | future `nomad`/`eks`) → a RunnerTransport. Built-ins
// self-register on import; a third-party kind registers via `registerRunnerBackend`.
export {
  registerRunnerBackend,
  runnerBackend,
  registeredRunnerBackendKinds,
  manifestRunnerBackend,
  kubernetesRunnerBackend,
  type RunnerBackendProvider,
  type RunnerBackendContext,
} from './modules/runners/runner-backends.js'
// The runtime-neutral runner transports: a generic manifest interpreter
// (`HttpRunnerPoolProvider`) + the per-job `RunnerPoolTransport`, and the native
// Kubernetes per-run-pod transport (`KubernetesRunnerTransport`, apiserver pod-proxy).
export {
  HttpRunnerPoolProvider,
  RunnerPoolApiError,
  type HttpRunnerPoolProviderOptions,
} from './modules/runners/HttpRunnerPoolProvider.js'
export { RunnerPoolTransport } from './modules/runners/RunnerPoolTransport.js'
export { KubernetesRunnerTransport } from './modules/kubernetes/KubernetesRunnerTransport.js'
export {
  KubernetesApiClient,
  type KubernetesClientConfig,
} from './modules/kubernetes/KubernetesApiClient.js'
export { KubernetesEnvironmentProvider } from './modules/kubernetes/KubernetesEnvironmentProvider.js'
export * as kubernetesLogic from './modules/kubernetes/kubernetes.logic.js'
export * as kubernetesEnvironmentLogic from './modules/kubernetes/kubernetes-environment.logic.js'
// Unified provisioning event log: the best-effort recorder every spin-up/down site
// writes through, and the read service behind the "View logs" drawers + run details.
export {
  ProvisioningLogRecorder,
  ProvisioningLogService,
  PROVISIONING_LOG_MAX_LIMIT,
  type ProvisioningLogEvent,
  type ProvisioningLogRecorderDependencies,
  type ProvisioningLogServiceDependencies,
} from './modules/provisioning-logs/ProvisioningLogService.js'
export {
  LoggingRunnerTransport,
  type LoggingRunnerTransportOptions,
} from './modules/provisioning-logs/LoggingRunnerTransport.js'
export { redactSecrets } from './modules/provisioning-logs/redact.js'

// Slack: an additional delivery transport for the existing notification mechanism
// (the `SlackNotificationChannel` implements the same `NotificationChannel` port),
// plus the per-account connection / per-workspace routing / member-mapping services.
export {
  SlackNotificationChannel,
  type SlackNotificationChannelDependencies,
} from './modules/slack/SlackNotificationChannel.js'
export {
  SlackConnectionService,
  type SlackConnectionServiceDependencies,
} from './modules/slack/SlackConnectionService.js'
export {
  SlackSettingsService,
  type SlackSettingsServiceDependencies,
} from './modules/slack/SlackSettingsService.js'
export {
  SlackMemberMappingService,
  type SlackMemberMappingServiceDependencies,
} from './modules/slack/SlackMemberMappingService.js'
export {
  SlackApiClient,
  SlackApiError,
  type SlackApiClientOptions,
  type SlackAuthInfo,
  type SlackOAuthResult,
} from './modules/slack/SlackApiClient.js'
export * as slackLogic from './modules/slack/slack.logic.js'
export {
  SLACK_CIPHER_INFO,
  SLACK_ROUTABLE_TYPES,
  defaultSlackSettings,
  renderNotificationMessage,
  resolveRoute,
} from './modules/slack/slack.logic.js'
export {
  ProviderSubscriptionService,
  type ProviderSubscriptionServiceDependencies,
  type VendorCredentialSummary,
  type LeasedSubscriptionToken,
} from './modules/providers/ProviderSubscriptionService.js'
export {
  ApiKeyService,
  type ApiKeyServiceDependencies,
  type ApiKeySummary,
  type LeasedApiKey,
  type PoolScopeOpts,
} from './modules/providers/ApiKeyService.js'
export {
  PersonalSubscriptionService,
  type PersonalSubscriptionServiceDependencies,
  type LeasedPersonalToken,
  DEFAULT_ACTIVATION_TTL_MS,
  DEFAULT_RENEW_WARNING_MS,
} from './modules/providers/PersonalSubscriptionService.js'
export {
  LocalModelEndpointService,
  type LocalModelEndpointServiceDependencies,
  type ResolvedLocalEndpoint,
} from './modules/providers/LocalModelEndpointService.js'
export { fetchLocalRunner, localRunnerUrlError } from './modules/providers/localModelUrl.js'
export {
  UserSecretService,
  type UserSecretServiceDependencies,
} from './modules/providers/UserSecretService.js'
export {
  registerUserSecretKind,
  getUserSecretKind,
  listUserSecretKinds,
  type UserSecretKindHandler,
  type UserSecretTestInput,
} from './modules/providers/userSecretKinds.js'
export {
  OpenRouterCatalogService,
  type OpenRouterCatalogServiceDependencies,
  OPENROUTER_BASE_URL,
  usdRateForSpendCurrency,
} from './modules/providers/OpenRouterCatalogService.js'
export * as providersLogic from './modules/providers/providers.logic.js'
export {
  DEFAULT_USAGE_WINDOW_MS,
  chooseToken,
  windowUsage,
  type PoolRotationRecord,
} from './modules/providers/providers.logic.js'

// Post-release-health: the pluggable observability provider the gate reads (a registry
// of vendor adapters — Datadog today) + the Datadog adapter / thin fetch client, plus the
// optional incident-enrichment providers (PagerDuty / incident.io) that annotate — never
// re-alert — an incident those systems already opened.
export {
  RegistryReleaseHealthProvider,
  type RegistryReleaseHealthProviderDependencies,
  type ObservabilityAdapter,
  type ObservabilityAdapterFactory,
  type ObservabilityProviderRegistry,
} from './modules/observability/RegistryReleaseHealthProvider.js'
export { defaultObservabilityRegistry } from './modules/observability/registry.js'
export {
  DatadogObservabilityAdapter,
  type DatadogCredentialsShape,
} from './modules/datadog/DatadogObservabilityAdapter.js'
export {
  DatadogClient,
  type DatadogCredentials,
  type DatadogClientOptions,
} from './modules/datadog/DatadogClient.js'
export {
  OBSERVABILITY_CIPHER_INFO,
  DatadogApiError,
  normalizeDatadogSite,
  datadogApiBase,
} from './modules/datadog/datadog.logic.js'
export {
  PagerDutyEnrichmentProvider,
  type PagerDutyEnrichmentProviderOptions,
} from './modules/pagerduty/PagerDutyEnrichmentProvider.js'
export {
  IncidentIoEnrichmentProvider,
  type IncidentIoEnrichmentProviderOptions,
} from './modules/incidentio/IncidentIoEnrichmentProvider.js'
export {
  WorkspaceIncidentEnrichmentProvider,
  INCIDENT_ENRICHMENT_CIPHER_INFO,
  type WorkspaceIncidentEnrichmentProviderDependencies,
} from './modules/incidentEnrichment/WorkspaceIncidentEnrichmentProvider.js'
export {
  AccountSettingsService,
  ACCOUNT_SETTINGS_CIPHER_INFO,
  type AccountSettingsServiceDependencies,
  type ResolvedAccountSettings,
} from './modules/accountSettings/AccountSettingsService.js'
export {
  LocalSettingsService,
  type LocalSettingsServiceDependencies,
} from './modules/localSettings/LocalSettingsService.js'

export {
  SendGridEmailSender,
  ResendEmailSender,
  createEmailSender,
  EMAIL_CIPHER_INFO,
  type EmailProviderConfig,
  type SendGridConfig,
  type ResendConfig,
} from './modules/email/adapters.js'
export {
  EmailConnectionService,
  type EmailConnectionServiceDependencies,
  type EmailConnection,
} from './modules/email/EmailConnectionService.js'
