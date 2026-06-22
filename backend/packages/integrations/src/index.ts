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
export { CONFLUENCE_DESCRIPTOR } from './modules/documents/confluence.logic.js'
export { NOTION_DESCRIPTOR } from './modules/documents/notion.logic.js'
export { GITHUB_DOCS_DESCRIPTOR } from './modules/documents/github-docs.logic.js'

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
export {
  TicketTrackerService,
  type TicketTrackerServiceDependencies,
  type JiraConnection,
  type FetchLike,
} from './modules/tracker/TicketTrackerService.js'
export * as jiraCreateLogic from './modules/tracker/jira.create.logic.js'
export {
  createGitHubIssueViaToken,
  type GitHubIssueTokenRequest,
} from './modules/tracker/github.create.logic.js'
export * as githubIssuesLogic from './modules/tasks/github-issues.logic.js'
export { GITHUB_ISSUES_DESCRIPTOR } from './modules/tasks/github-issues.logic.js'

export {
  EnvironmentConnectionService,
  type EnvironmentConnectionServiceDependencies,
  type ResolvedConnection,
  referencedSecretKeys,
} from './modules/environments/EnvironmentConnectionService.js'
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
export {
  isDeployStep,
  DEPLOYER_AGENT_KIND,
  ENVIRONMENT_BLOCK_TYPE,
} from './modules/environments/environments.logic.js'

export {
  RunnerPoolConnectionService,
  type RunnerPoolConnectionServiceDependencies,
  type ResolvedRunnerPool,
} from './modules/runners/RunnerPoolConnectionService.js'
export * as runnersLogic from './modules/runners/runners.logic.js'
// The runtime-neutral self-hosted runner-pool transport: a generic manifest
// interpreter (`HttpRunnerPoolProvider`) and the per-job `RunnerTransport` adapter
// (`RunnerPoolTransport`) both runtime facades resolve for a workspace's pool.
export {
  HttpRunnerPoolProvider,
  RunnerPoolApiError,
  type HttpRunnerPoolProviderOptions,
} from './modules/runners/HttpRunnerPoolProvider.js'
export { RunnerPoolTransport } from './modules/runners/RunnerPoolTransport.js'

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
  PersonalSubscriptionService,
  type PersonalSubscriptionServiceDependencies,
  type LeasedPersonalToken,
  DEFAULT_ACTIVATION_TTL_MS,
  DEFAULT_RENEW_WARNING_MS,
} from './modules/providers/PersonalSubscriptionService.js'
export * as providersLogic from './modules/providers/providers.logic.js'
export {
  DEFAULT_USAGE_WINDOW_MS,
  chooseToken,
  windowUsage,
} from './modules/providers/providers.logic.js'
