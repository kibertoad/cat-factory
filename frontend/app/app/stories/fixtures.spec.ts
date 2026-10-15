import {
  accountInvitationSchema,
  accountMemberSchema,
  accountSchema,
  accountSettingsViewSchema,
  agentEffortReportSchema,
  apiKeySchema,
  blockSchema,
  connectionTestResultSchema,
  documentConnectionSchema,
  documentSourceDescriptorSchema,
  emailConnectionSchema,
  environmentConnectionSchema,
  fragmentSourceSchema,
  localModelEndpointSchema,
  modelOptionSchema,
  personalSubscriptionStatusSchema,
  promptFragmentSchema,
  providerDescriptorSchema,
  reproductionReportSchema,
  resolvedDocumentRefSchema,
  resolvedFragmentSchema,
  runnerPoolConnectionSchema,
  runnerPoolManifestSchema,
  slackConnectionSchema,
  sourceDocumentSchema,
  sourceTaskSchema,
  spendStatusSchema,
  taskConnectionSchema,
  taskSearchResultSchema,
  taskSourceStateSchema,
  validationReportSchema,
  vendorCredentialSchema,
  workspaceListItemSchema,
  workspaceMemberSchema,
  companionVerdictSchema,
  decisionSchema,
  githubAvailableRepoSchema,
  githubInstallationOptionSchema,
  githubIssueSchema,
  githubPullRequestSchema,
  githubRepoSchema,
  runInputGateSchema,
  stepApprovalSchema,
  vcsConnectOptionSchema,
  workspaceSnapshotSchema,
} from '@cat-factory/contracts'
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import {
  accountBoards,
  accountMembers,
  accountSettingsView,
  accounts,
  invitations,
  resendConnection,
  workspaceMembers,
} from './accounts.stories.mocks'
import { authInitiative } from './board.stories.mocks'
import {
  accountFragments,
  handbookSource,
  layeredCatalog,
  platformStandardsSource,
  workspaceFragments,
} from './fragments.stories.mocks'
import {
  authServiceIssues,
  documentConnections,
  documentSources,
  resolvedDocumentRef,
  resolvedDocumentRefWithDroppedScope,
  resolvedFigmaFrameRef,
  sessionSearchHits,
  slackConnection,
  sourceDocuments,
  sourceTasks,
  taskConnections,
  taskSources,
  zeplinDescriptor,
} from './integrations.stories.mocks'
import {
  approval,
  blockedInputGate,
  companionVerdicts,
  decision,
} from './pipelineStep.stories.mocks'
import {
  accountApiKeys,
  apiKey,
  claudeOnlyCatalog,
  connectionTestWithWarnings,
  environmentConnection,
  kubernetesEnvironmentDescriptor,
  kubernetesRunnerConnection,
  kubernetesRunnerDescriptor,
  localModelEndpoint,
  manifestRunnerDescriptor,
  personalSubscription,
  presetModelCatalog,
  providerDescriptor,
  runnerPoolConnection,
  runnerPoolManifest,
  spendStatus,
  vendorCredential,
} from './providers.stories.mocks'
import { execution, parkedExecution, snapshot } from './snapshot.stories.mocks'
import {
  effortReport,
  reproductionReport,
  validationFailed,
  validationPassed,
} from './stepReports.stories.mocks'
import {
  authRepo,
  availableRepos,
  githubInstallations,
  githubIssues,
  platformRepo,
  pullRequests,
  vcsConnectOptions,
} from './vcs.stories.mocks'

// The shared story fixtures, each parsed with the contract schema the backend answers with. The
// typecheck already holds them to the TYPE; this also holds them to what the type cannot say (an
// id pattern, a minimum, a non-empty list), so a story never renders a row the API would refuse.
const cases: [string, v.GenericSchema, unknown[]][] = [
  ['account', accountSchema, accounts],
  ['account settings', accountSettingsViewSchema, [accountSettingsView]],
  ['workspace member', workspaceMemberSchema, workspaceMembers],
  ['account member', accountMemberSchema, accountMembers],
  ['account invitation', accountInvitationSchema, invitations],
  ['email connection', emailConnectionSchema, [resendConnection]],
  ['board list item', workspaceListItemSchema, accountBoards],
  ['prompt fragment', promptFragmentSchema, [...workspaceFragments, ...accountFragments]],
  ['fragment source', fragmentSourceSchema, [handbookSource, platformStandardsSource]],
  ['resolved fragment', resolvedFragmentSchema, layeredCatalog],
  ['task source', taskSourceStateSchema, taskSources],
  ['task connection', taskConnectionSchema, taskConnections],
  ['source task', sourceTaskSchema, [...sourceTasks, ...authServiceIssues]],
  ['task search result', taskSearchResultSchema, sessionSearchHits],
  ['document source', documentSourceDescriptorSchema, [...documentSources, zeplinDescriptor]],
  ['document connection', documentConnectionSchema, documentConnections],
  ['source document', sourceDocumentSchema, sourceDocuments],
  [
    'resolved document ref',
    resolvedDocumentRefSchema,
    [resolvedDocumentRef, resolvedDocumentRefWithDroppedScope, resolvedFigmaFrameRef],
  ],
  ['slack connection', slackConnectionSchema, [slackConnection]],
  ['environment connection', environmentConnectionSchema, [environmentConnection]],
  [
    'runner pool connection',
    runnerPoolConnectionSchema,
    [runnerPoolConnection, kubernetesRunnerConnection],
  ],
  ['runner pool manifest', runnerPoolManifestSchema, [runnerPoolManifest]],
  [
    'provider descriptor',
    providerDescriptorSchema,
    [
      providerDescriptor(environmentConnection),
      manifestRunnerDescriptor,
      kubernetesRunnerDescriptor(true),
      kubernetesRunnerDescriptor(false),
      kubernetesEnvironmentDescriptor,
    ],
  ],
  ['connection test', connectionTestResultSchema, [connectionTestWithWarnings]],
  ['local model endpoint', localModelEndpointSchema, [localModelEndpoint()]],
  ['personal subscription', personalSubscriptionStatusSchema, [personalSubscription()]],
  ['vendor credential', vendorCredentialSchema, [vendorCredential()]],
  ['API key', apiKeySchema, [apiKey(), ...accountApiKeys]],
  ['spend status', spendStatusSchema, [spendStatus()]],
  ['model option', modelOptionSchema, [...claudeOnlyCatalog, ...presetModelCatalog]],
  ['effort report', agentEffortReportSchema, [effortReport]],
  ['validation report', validationReportSchema, [validationPassed, validationFailed]],
  ['reproduction report', reproductionReportSchema, [reproductionReport()]],
  ['initiative block', blockSchema, [authInitiative]],
  ['GitHub repo', githubRepoSchema, [authRepo, platformRepo]],
  ['step approval', stepApprovalSchema, [approval()]],
  ['step decision', decisionSchema, [decision(), decision({ chosen: 'In process only' })]],
  ['companion verdict', companionVerdictSchema, companionVerdicts],
  ['input gate', runInputGateSchema, [blockedInputGate]],
  ['available repo', githubAvailableRepoSchema, availableRepos],
  ['GitHub installation', githubInstallationOptionSchema, githubInstallations],
  ['VCS connect option', vcsConnectOptionSchema, vcsConnectOptions],
  ['pull request', githubPullRequestSchema, pullRequests],
  ['GitHub issue', githubIssueSchema, githubIssues],
  [
    'board snapshot',
    workspaceSnapshotSchema,
    [snapshot(), snapshot({ executions: [execution(), parkedExecution()] })],
  ],
]

describe('shared story fixtures', () => {
  it.each(cases)('every %s matches its contract schema', (_name, schema, rows) => {
    for (const row of rows) {
      const result = v.safeParse(schema, row)
      expect(
        result.issues?.map((issue) => `${v.getDotPath(issue)}: ${issue.message}`),
      ).toBeUndefined()
    }
  })
})
