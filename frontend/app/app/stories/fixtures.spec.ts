import {
  accountInvitationSchema,
  accountMemberSchema,
  accountSchema,
  accountSettingsViewSchema,
  accountSkillSchema,
  agentEffortReportSchema,
  agentFailureSchema,
  apiKeySchema,
  blockSchema,
  bootstrapJobSchema,
  companionVerdictSchema,
  connectionTestResultSchema,
  customAgentKindSchema,
  decisionSchema,
  documentConnectionSchema,
  documentSourceDescriptorSchema,
  emailConnectionSchema,
  environmentConnectionSchema,
  fragmentSourceSchema,
  githubAvailableRepoSchema,
  githubBranchSchema,
  githubConnectionSchema,
  githubInstallationOptionSchema,
  githubIssueSchema,
  githubPullRequestSchema,
  githubRepoSchema,
  localModelEndpointSchema,
  mergeClassRollupSchema,
  modelOptionSchema,
  modelPresetSchema,
  notificationSchema,
  personalSubscriptionStatusSchema,
  pipelineSchema,
  prReviewStatusSchema,
  prReviewStepStateSchema,
  priorStepOutputSchema,
  promptFragmentSchema,
  providerDescriptorSchema,
  referenceArchitectureSchema,
  repoTreeEntrySchema,
  resolvedDocumentRefSchema,
  resolvedFragmentSchema,
  riskPolicyLibraryEntrySchema,
  reproductionReportSchema,
  runInputGateSchema,
  runnerPoolConnectionSchema,
  runnerPoolManifestSchema,
  serviceSchema,
  skillSourceSchema,
  skillSummarySchema,
  slackConnectionSchema,
  sourceDocumentSchema,
  sourceTaskSchema,
  spendStatusSchema,
  stepApprovalSchema,
  taskConnectionSchema,
  taskEstimateSchema,
  taskSearchResultSchema,
  taskSourceStateSchema,
  validationReportSchema,
  vcsConnectOptionSchema,
  vendorCredentialSchema,
  workspaceListItemSchema,
  workspaceMemberSchema,
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
import { block, estimate } from './block.stories.mocks'
import { authInitiative } from './board.stories.mocks'
import {
  adoptionDecisions,
  applyingJob,
  awaitingReviewJob,
  bootstrapJob,
  failedApplyJob,
  referenceArchitectures,
  succeededNewRepoJob,
  surveyReads,
} from './bootstrap.stories.mocks'
import {
  accountFragments,
  fragmentCatalog,
  handbookSource,
  layeredCatalog,
  platformStandardsSource,
  workspaceFragments,
} from './fragments.stories.mocks'
import {
  awaitingAnswersSnapshot,
  initiative,
  initiativeItems,
  initiativeSnapshot,
  interviewQuestions,
  interviewingSnapshot,
  planGateSnapshot,
  trackedInitiative,
} from './initiative.stories.mocks'
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
import { laneSnapshot, queueSnapshot } from './lanes.stories.mocks'
import { mergeClassRollups } from './mergeTrackRecord.stories.mocks'
import {
  ciFailedCard,
  mergeReviewCard,
  platformHealthCard,
  prReviewCard,
} from './notifications.stories.mocks'
import {
  approval,
  blockedInputGate,
  companionVerdicts,
  decision,
  failure,
  prReview,
  priorOutput,
} from './pipelineStep.stories.mocks'
import {
  adaptiveBuild,
  bugFishingPipeline,
  bugTriagePipeline,
  bugfixPipeline,
  documentPipeline,
  reproTestKind,
  reviewPipeline,
  standardBuild,
} from './pipelines.stories.mocks'
import {
  accountStrictPolicy,
  manualReviewPolicy,
  modelPreset,
  modelPresetLibrary,
  riskPolicy,
} from './policies.stories.mocks'
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
import { billingMigrations, platformFiles } from './repoFiles.stories.mocks'
import { accountSkills, skillCatalog, skillSource } from './skills.stories.mocks'
import { execution, parkedExecution, snapshot } from './snapshot.stories.mocks'
import { taskFormSnapshot } from './taskForm.stories.mocks'
import {
  effortReport,
  reproductionReport,
  validationFailed,
  validationPassed,
} from './stepReports.stories.mocks'
import {
  authBranches,
  authRepo,
  authServiceRow,
  availableRepos,
  gatewayRepo,
  githubConnection,
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
  ['prompt fragment', promptFragmentSchema, [...workspaceFragments, ...accountFragments]],
  ['fragment source', fragmentSourceSchema, [handbookSource, platformStandardsSource]],
  ['resolved fragment', resolvedFragmentSchema, [...layeredCatalog, ...fragmentCatalog]],
  ['board list item', workspaceListItemSchema, accountBoards],
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
  ['block', blockSchema, [block(), authInitiative]],
  ['task estimate', taskEstimateSchema, [estimate()]],
  ['GitHub connection', githubConnectionSchema, [githubConnection]],
  ['service', serviceSchema, [authServiceRow]],
  ['GitHub branch', githubBranchSchema, authBranches],
  ['agent failure', agentFailureSchema, [failure()]],
  ['prior step output', priorStepOutputSchema, [priorOutput()]],
  ['PR review state', prReviewStepStateSchema, prReviewStatusSchema.options.map(prReview)],
  [
    'bootstrap job',
    bootstrapJobSchema,
    [bootstrapJob(), awaitingReviewJob(), applyingJob(), failedApplyJob(), succeededNewRepoJob()],
  ],
  ['reference architecture', referenceArchitectureSchema, referenceArchitectures],
  ['GitHub repo', githubRepoSchema, [authRepo, platformRepo, gatewayRepo]],
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
  ['merge class rollup', mergeClassRollupSchema, mergeClassRollups],
  ['step approval', stepApprovalSchema, [approval()]],
  ['step decision', decisionSchema, [decision(), decision({ chosen: 'In process only' })]],
  [
    'risk policy',
    riskPolicyLibraryEntrySchema,
    [riskPolicy(), manualReviewPolicy, accountStrictPolicy],
  ],
  ['model preset', modelPresetSchema, [modelPreset(), ...modelPresetLibrary]],
  [
    'pipeline',
    pipelineSchema,
    [
      standardBuild,
      adaptiveBuild,
      bugfixPipeline,
      documentPipeline,
      reviewPipeline,
      bugFishingPipeline,
      bugTriagePipeline,
    ],
  ],
  ['custom agent kind', customAgentKindSchema, [reproTestKind]],
  ['companion verdict', companionVerdictSchema, companionVerdicts],
  ['input gate', runInputGateSchema, [blockedInputGate]],
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
  ['available repo', githubAvailableRepoSchema, availableRepos],
  ['GitHub installation', githubInstallationOptionSchema, githubInstallations],
  ['VCS connect option', vcsConnectOptionSchema, vcsConnectOptions],
  ['skill summary', skillSummarySchema, skillCatalog],
  ['account skill', accountSkillSchema, accountSkills],
  ['skill source', skillSourceSchema, [skillSource]],
  ['repo tree entry', repoTreeEntrySchema, [...platformFiles, ...billingMigrations]],
  ['pull request', githubPullRequestSchema, pullRequests],
  ['GitHub issue', githubIssueSchema, githubIssues],
  [
    'board snapshot',
    workspaceSnapshotSchema,
    [
      snapshot(),
      snapshot({ executions: [execution(), parkedExecution()] }),
      laneSnapshot(),
      queueSnapshot(),
      initiativeSnapshot(initiative({ status: 'executing', items: initiativeItems })),
      initiativeSnapshot(initiative({ qa: interviewQuestions })),
      initiativeSnapshot(trackedInitiative()),
      awaitingAnswersSnapshot(),
      interviewingSnapshot(),
      planGateSnapshot(),
      planGateSnapshot({ rendered: true }),
      taskFormSnapshot(),
    ],
  ],
  [
    'notification',
    notificationSchema,
    [mergeReviewCard, ciFailedCard, prReviewCard, platformHealthCard],
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

// Components join a repo on its `githubId`, so a repo listed under two ids shows up unlinked, or
// twice, in a story that seeds one fixture and lists the other.
describe('the repo fixtures', () => {
  it('give each repo one githubId', () => {
    const ids = new Map<string, Set<number>>()
    for (const repo of [authRepo, platformRepo, gatewayRepo, ...availableRepos]) {
      const name = `${repo.owner}/${repo.name}`
      ids.set(name, (ids.get(name) ?? new Set()).add(repo.githubId))
    }
    expect([...ids].filter(([, set]) => set.size > 1).map(([name]) => name)).toEqual([])
  })
})

// The backend drops a recommendation whose evidence names no path the survey read
// (`surveyedPaths` in kernel's `monorepo-adoption.logic.ts`), so a story decision that cited one
// would show a plan the backend never stores.
describe('the adoption fixture', () => {
  it('cites only paths the survey read', () => {
    const read = new Set(surveyReads.filter((r) => r.outcome === 'read').map((r) => r.path))
    const cited = adoptionDecisions.flatMap((d) => d.evidence)
    expect(cited.filter((path) => !read.has(path))).toEqual([])
  })
})
