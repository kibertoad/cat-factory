// Public surface of the external-system integration layer.

export {
  GitHubInstallationService,
  type GitHubInstallationServiceDependencies,
} from './modules/github/GitHubInstallationService'
export { GitHubService, type GitHubServiceDependencies } from './modules/github/GitHubService'
export {
  GitHubSyncService,
  type GitHubSyncServiceDependencies,
} from './modules/github/GitHubSyncService'
export { WebhookService, type WebhookServiceDependencies } from './modules/github/WebhookService'
export * as githubProjection from './modules/github/projection.logic'
export {
  RepoProvisioningService,
  type RepoProvisioningServiceDependencies,
  type DelegationReason,
  type ProvisionResult,
} from './modules/github/RepoProvisioningService'
export { canCreateRepo } from './modules/github/provisioning.logic'

export {
  DocumentConnectionService,
  type DocumentConnectionServiceDependencies,
} from './modules/documents/DocumentConnectionService'
export {
  DocumentImportService,
  type DocumentImportServiceDependencies,
  toSourceDocument,
} from './modules/documents/DocumentImportService'
export {
  DocumentPlannerService,
  type DocumentPlannerServiceDependencies,
} from './modules/documents/DocumentPlannerService'
export {
  DocumentLinkService,
  type DocumentLinkServiceDependencies,
  type SpawnResult,
} from './modules/documents/DocumentLinkService'
export { MapDocumentSourceRegistry } from './modules/documents/documents.logic'
export * as documentsLogic from './modules/documents/documents.logic'
export * as confluenceLogic from './modules/documents/confluence.logic'
export * as notionLogic from './modules/documents/notion.logic'
export { CONFLUENCE_DESCRIPTOR } from './modules/documents/confluence.logic'
export { NOTION_DESCRIPTOR } from './modules/documents/notion.logic'

export {
  TaskConnectionService,
  type TaskConnectionServiceDependencies,
} from './modules/tasks/TaskConnectionService'
export {
  TaskImportService,
  type TaskImportServiceDependencies,
  toSourceTask,
} from './modules/tasks/TaskImportService'
export { TaskLinkService, type TaskLinkServiceDependencies } from './modules/tasks/TaskLinkService'
export {
  MapTaskSourceRegistry,
  type TaskContextView,
  renderTaskContext,
  buildTaskExcerpt,
} from './modules/tasks/tasks.logic'
export * as tasksLogic from './modules/tasks/tasks.logic'
export * as jiraLogic from './modules/tasks/jira.logic'
export { JIRA_DESCRIPTOR } from './modules/tasks/jira.logic'
export * as githubIssuesLogic from './modules/tasks/github-issues.logic'
export { GITHUB_ISSUES_DESCRIPTOR } from './modules/tasks/github-issues.logic'

export {
  EnvironmentConnectionService,
  type EnvironmentConnectionServiceDependencies,
  type ResolvedConnection,
  referencedSecretKeys,
} from './modules/environments/EnvironmentConnectionService'
export {
  EnvironmentProvisioningService,
  type EnvironmentProvisioningServiceDependencies,
  type ProvisionArgs,
  type ResolvedEnvironment,
} from './modules/environments/EnvironmentProvisioningService'
export {
  EnvironmentTeardownService,
  type EnvironmentTeardownServiceDependencies,
} from './modules/environments/EnvironmentTeardownService'
export * as environmentsLogic from './modules/environments/environments.logic'
export {
  isDeployStep,
  DEPLOYER_AGENT_KIND,
  ENVIRONMENT_BLOCK_TYPE,
} from './modules/environments/environments.logic'

export {
  RunnerPoolConnectionService,
  type RunnerPoolConnectionServiceDependencies,
  type ResolvedRunnerPool,
} from './modules/runners/RunnerPoolConnectionService'
export * as runnersLogic from './modules/runners/runners.logic'
