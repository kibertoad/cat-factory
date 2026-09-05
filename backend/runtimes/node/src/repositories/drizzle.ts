// Barrel for the Drizzle/Postgres core repositories. The concrete port
// implementations are split by domain under ./drizzle/*; this module assembles them
// into the CoreRepositories set and re-exports the handful consumed directly by
// callers (index.ts, container.ts, the test harness). Split out of a single
// ~5,000-line module — see docs/internal/refactoring-candidates.md #1.

import type {
  AccountInvitationRepository,
  AccountRepository,
  AccountSettingsRepository,
  AgentContextSnapshotRepository,
  AgentPromptRepository,
  AgentRunRepository,
  AgentSearchQueryRepository,
  AgentToolCallRepository,
  BinaryArtifactMetadataStore,
  BlockRepository,
  BrainstormSessionRepository,
  CapabilityCredentialRepository,
  McpOAuthGrantRepository,
  ClarityReviewRepository,
  Clock,
  ConsensusGroupRepository,
  ConsensusSessionRepository,
  DocInterviewRepository,
  EmailConnectionRepository,
  ExecutionRepository,
  GateOutcomeRepository,
  IncidentEnrichmentConnectionRepository,
  InitiativeRepository,
  KaizenGradingRepository,
  KaizenVerifiedComboRepository,
  LlmCallMetricRepository,
  MembershipRepository,
  MergeTrackRecordRepository,
  ModelPresetRepository,
  ObservabilityConnectionRepository,
  ServiceCatalogConnectionRepository,
  PackageRegistryConnectionRepository,
  AuditEventRepository,
  AuthAttemptRepository,
  MachineNodeRepository,
  PasswordResetTokenRepository,
  PipelineRepository,
  PipelineScheduleRepository,
  PlatformMetricsRepository,
  ProvisioningLogRepository,
  ReleaseHealthConfigRepository,
  ReportsRepository,
  RequirementReviewRepository,
  AccountRiskPolicyRepository,
  RiskPolicyRepository,
  RiskPolicySuppressionRepository,
  ServiceFragmentDefaultsRepository,
  ServiceRepository,
  SpendRollupRepository,
  SharedStackRepository,
  SubscriptionQuotaCycleRepository,
  TestSecretsRepository,
  TokenUsageRepository,
  TrackerSettingsRepository,
  UserRepository,
  TutorialProgressRepository,
  UserSettingsRepository,
  ValidationConfigRepository,
  TaskTypeSuppressionRepository,
  WorkspaceAgentSettingsRepository,
  WorkspaceMemberRepository,
  WorkspaceMountRepository,
  WorkspaceRepository,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'

import type { DrizzleDb } from '../db/client.js'

import {
  DrizzleBlockRepository,
  DrizzleServiceFragmentDefaultsRepository,
  DrizzleServiceRepository,
  DrizzleWorkspaceMemberRepository,
  DrizzleWorkspaceMountRepository,
  DrizzleWorkspaceRepository,
} from './drizzle/board.js'

import {
  DrizzleAgentRunRepository,
  DrizzleExecutionRepository,
  DrizzleGateOutcomeRepository,
  DrizzlePipelineRepository,
  DrizzlePipelineScheduleRepository,
  DrizzlePlatformMetricsRepository,
} from './drizzle/execution.js'

import { DrizzleReportsRepository } from './drizzle/reports.js'
import { DrizzleSpendRollupRepository } from './drizzle/spendRollup.js'

import {
  DrizzleAccountInvitationRepository,
  DrizzleAccountRepository,
  DrizzleAuditEventRepository,
  DrizzleAuthAttemptRepository,
  DrizzleEmailConnectionRepository,
  DrizzleMachineNodeRepository,
  DrizzleMembershipRepository,
  DrizzlePasswordResetTokenRepository,
  DrizzleUserRepository,
} from './drizzle/accounts.js'

import {
  DrizzleAgentContextSnapshotRepository,
  DrizzleAgentSearchQueryRepository,
  DrizzleAgentToolCallRepository,
  DrizzleBinaryArtifactMetadataStore,
  DrizzleLlmCallMetricRepository,
  DrizzleProvisioningLogRepository,
} from './drizzle/telemetry.js'
import { DrizzleTokenUsageRepository } from './drizzle/tokenUsage.js'

import {
  DrizzleAccountSettingsRepository,
  DrizzleAgentPromptRepository,
  DrizzleTaskTypeSuppressionRepository,
  DrizzleWorkspaceAgentSettingsRepository,
  DrizzleModelPresetRepository,
  DrizzleTrackerSettingsRepository,
  DrizzleTutorialProgressRepository,
  DrizzleUserSettingsRepository,
  DrizzleWorkspaceSettingsRepository,
} from './drizzle/settings.js'

import {
  DrizzleBrainstormSessionRepository,
  DrizzleClarityReviewRepository,
  DrizzleConsensusGroupRepository,
  DrizzleConsensusSessionRepository,
  DrizzleDocInterviewRepository,
  DrizzleRequirementReviewRepository,
} from './drizzle/reviews.js'

import {
  DrizzleKaizenGradingRepository,
  DrizzleKaizenVerifiedComboRepository,
} from './drizzle/kaizen.js'

import {
  DrizzleInitiativeRepository,
  DrizzleRiskPolicyRepository,
  DrizzleSharedStackRepository,
} from './drizzle/initiatives.js'

import {
  DrizzleAccountRiskPolicyRepository,
  DrizzleRiskPolicySuppressionRepository,
} from './drizzle/account-risk-policies.js'

import { DrizzleMergeTrackRecordRepository } from './drizzle/mergeTrackRecord.js'

import {
  DrizzleIncidentEnrichmentConnectionRepository,
  DrizzleObservabilityConnectionRepository,
  DrizzlePackageRegistryConnectionRepository,
  DrizzleReleaseHealthConfigRepository,
  DrizzleValidationConfigRepository,
  DrizzleSubscriptionQuotaCycleRepository,
  DrizzleTestSecretsRepository,
  DrizzleCapabilityCredentialRepository,
  DrizzleMcpOAuthGrantRepository,
} from './drizzle/connections.js'

import { DrizzleServiceCatalogConnectionRepository } from './drizzle/serviceCatalog.js'

export interface CoreRepositories {
  workspaceRepository: WorkspaceRepository
  workspaceMemberRepository: WorkspaceMemberRepository
  accountRepository: AccountRepository
  membershipRepository: MembershipRepository
  userRepository: UserRepository
  invitationRepository: AccountInvitationRepository
  passwordResetTokenRepository: PasswordResetTokenRepository
  machineNodeRepository: MachineNodeRepository
  authAttemptRepository: AuthAttemptRepository
  auditEventRepository: AuditEventRepository
  emailConnectionRepository: EmailConnectionRepository
  blockRepository: BlockRepository
  pipelineRepository: PipelineRepository
  executionRepository: ExecutionRepository
  tokenUsageRepository: TokenUsageRepository
  llmCallMetricRepository: LlmCallMetricRepository
  agentContextSnapshotRepository: AgentContextSnapshotRepository
  agentSearchQueryRepository: AgentSearchQueryRepository
  agentToolCallRepository: AgentToolCallRepository
  binaryArtifactMetadataStore: BinaryArtifactMetadataStore
  agentRunRepository: AgentRunRepository
  platformMetricsRepository: PlatformMetricsRepository
  gateOutcomeRepository: GateOutcomeRepository
  reportsRepository: ReportsRepository
  spendRollupRepository: SpendRollupRepository
  modelPresetRepository: ModelPresetRepository
  agentPromptRepository: AgentPromptRepository
  workspaceAgentSettingsRepository: WorkspaceAgentSettingsRepository
  taskTypeSuppressionRepository: TaskTypeSuppressionRepository
  serviceFragmentDefaultsRepository: ServiceFragmentDefaultsRepository
  pipelineScheduleRepository: PipelineScheduleRepository
  trackerSettingsRepository: TrackerSettingsRepository
  serviceRepository: ServiceRepository
  workspaceMountRepository: WorkspaceMountRepository
  requirementReviewRepository: RequirementReviewRepository
  docInterviewRepository: DocInterviewRepository
  kaizenGradingRepository: KaizenGradingRepository
  kaizenVerifiedComboRepository: KaizenVerifiedComboRepository
  consensusSessionRepository: ConsensusSessionRepository
  consensusGroupRepository: ConsensusGroupRepository
  clarityReviewRepository: ClarityReviewRepository
  brainstormSessionRepository: BrainstormSessionRepository
  initiativeRepository: InitiativeRepository
  riskPolicyRepository: RiskPolicyRepository
  accountRiskPolicyRepository: AccountRiskPolicyRepository
  riskPolicySuppressionRepository: RiskPolicySuppressionRepository
  mergeTrackRecordRepository: MergeTrackRecordRepository
  sharedStackRepository: SharedStackRepository
  workspaceSettingsRepository: WorkspaceSettingsRepository
  tutorialProgressRepository: TutorialProgressRepository
  userSettingsRepository: UserSettingsRepository
  observabilityConnectionRepository: ObservabilityConnectionRepository
  serviceCatalogConnectionRepository: ServiceCatalogConnectionRepository
  packageRegistryConnectionRepository: PackageRegistryConnectionRepository
  incidentEnrichmentConnectionRepository: IncidentEnrichmentConnectionRepository
  accountSettingsRepository: AccountSettingsRepository
  releaseHealthConfigRepository: ReleaseHealthConfigRepository
  subscriptionQuotaCycleRepository: SubscriptionQuotaCycleRepository
  testSecretsRepository: TestSecretsRepository
  capabilityCredentialRepository: CapabilityCredentialRepository
  mcpOAuthGrantRepository: McpOAuthGrantRepository
  validationConfigRepository: ValidationConfigRepository
  provisioningLogRepository: ProvisioningLogRepository
}

/** Build the Drizzle/Postgres-backed core repositories. */
export function createDrizzleRepositories(db: DrizzleDb, clock: Clock): CoreRepositories {
  return {
    workspaceRepository: new DrizzleWorkspaceRepository(db),
    workspaceMemberRepository: new DrizzleWorkspaceMemberRepository(db),
    accountRepository: new DrizzleAccountRepository(db),
    membershipRepository: new DrizzleMembershipRepository(db),
    userRepository: new DrizzleUserRepository(db),
    invitationRepository: new DrizzleAccountInvitationRepository(db),
    passwordResetTokenRepository: new DrizzlePasswordResetTokenRepository(db),
    machineNodeRepository: new DrizzleMachineNodeRepository(db),
    authAttemptRepository: new DrizzleAuthAttemptRepository(db),
    auditEventRepository: new DrizzleAuditEventRepository(db),
    emailConnectionRepository: new DrizzleEmailConnectionRepository(db),
    blockRepository: new DrizzleBlockRepository(db),
    pipelineRepository: new DrizzlePipelineRepository(db),
    executionRepository: new DrizzleExecutionRepository(db, clock),
    tokenUsageRepository: new DrizzleTokenUsageRepository(db),
    llmCallMetricRepository: new DrizzleLlmCallMetricRepository(db),
    agentContextSnapshotRepository: new DrizzleAgentContextSnapshotRepository(db),
    agentSearchQueryRepository: new DrizzleAgentSearchQueryRepository(db),
    agentToolCallRepository: new DrizzleAgentToolCallRepository(db),
    binaryArtifactMetadataStore: new DrizzleBinaryArtifactMetadataStore(db),
    agentRunRepository: new DrizzleAgentRunRepository(db),
    platformMetricsRepository: new DrizzlePlatformMetricsRepository(db),
    gateOutcomeRepository: new DrizzleGateOutcomeRepository(db),
    reportsRepository: new DrizzleReportsRepository(db),
    spendRollupRepository: new DrizzleSpendRollupRepository(db),
    modelPresetRepository: new DrizzleModelPresetRepository(db),
    agentPromptRepository: new DrizzleAgentPromptRepository(db),
    workspaceAgentSettingsRepository: new DrizzleWorkspaceAgentSettingsRepository(db),
    taskTypeSuppressionRepository: new DrizzleTaskTypeSuppressionRepository(db),
    serviceFragmentDefaultsRepository: new DrizzleServiceFragmentDefaultsRepository(db),
    pipelineScheduleRepository: new DrizzlePipelineScheduleRepository(db),
    trackerSettingsRepository: new DrizzleTrackerSettingsRepository(db),
    serviceRepository: new DrizzleServiceRepository(db),
    workspaceMountRepository: new DrizzleWorkspaceMountRepository(db),
    requirementReviewRepository: new DrizzleRequirementReviewRepository(db),
    docInterviewRepository: new DrizzleDocInterviewRepository(db),
    kaizenGradingRepository: new DrizzleKaizenGradingRepository(db),
    kaizenVerifiedComboRepository: new DrizzleKaizenVerifiedComboRepository(db),
    consensusSessionRepository: new DrizzleConsensusSessionRepository(db),
    consensusGroupRepository: new DrizzleConsensusGroupRepository(db),
    clarityReviewRepository: new DrizzleClarityReviewRepository(db),
    brainstormSessionRepository: new DrizzleBrainstormSessionRepository(db),
    initiativeRepository: new DrizzleInitiativeRepository(db),
    riskPolicyRepository: new DrizzleRiskPolicyRepository(db),
    accountRiskPolicyRepository: new DrizzleAccountRiskPolicyRepository(db),
    riskPolicySuppressionRepository: new DrizzleRiskPolicySuppressionRepository(db),
    mergeTrackRecordRepository: new DrizzleMergeTrackRecordRepository(db),
    sharedStackRepository: new DrizzleSharedStackRepository(db),
    workspaceSettingsRepository: new DrizzleWorkspaceSettingsRepository(db),
    tutorialProgressRepository: new DrizzleTutorialProgressRepository(db),
    userSettingsRepository: new DrizzleUserSettingsRepository(db),
    observabilityConnectionRepository: new DrizzleObservabilityConnectionRepository(db),
    serviceCatalogConnectionRepository: new DrizzleServiceCatalogConnectionRepository(db),
    packageRegistryConnectionRepository: new DrizzlePackageRegistryConnectionRepository(db),
    incidentEnrichmentConnectionRepository: new DrizzleIncidentEnrichmentConnectionRepository(db),
    accountSettingsRepository: new DrizzleAccountSettingsRepository(db),
    releaseHealthConfigRepository: new DrizzleReleaseHealthConfigRepository(db),
    validationConfigRepository: new DrizzleValidationConfigRepository(db),
    subscriptionQuotaCycleRepository: new DrizzleSubscriptionQuotaCycleRepository(db),
    testSecretsRepository: new DrizzleTestSecretsRepository(db),
    capabilityCredentialRepository: new DrizzleCapabilityCredentialRepository(db),
    mcpOAuthGrantRepository: new DrizzleMcpOAuthGrantRepository(db),
    provisioningLogRepository: new DrizzleProvisioningLogRepository(db),
  }
}

// Re-exported for direct consumers (see index.ts / test harness).
export {
  DrizzleServiceRepository,
  DrizzleWorkspaceMemberRepository,
  DrizzleWorkspaceRepository,
} from './drizzle/board.js'
export {
  DrizzleAccountSettingsRepository,
  DrizzleLocalSettingsRepository,
  DrizzleWorkspaceSettingsRepository,
} from './drizzle/settings.js'
export {
  DrizzleClarityReviewRepository,
  DrizzleDocInterviewRepository,
  DrizzleRequirementReviewRepository,
} from './drizzle/reviews.js'
// The account tier of the risk-policy library (ADR 0055). Re-exported so the conformance harness
// can author an account policy against the real store.
export { DrizzleAccountRiskPolicyRepository } from './drizzle/account-risk-policies.js'
export { createDrizzleSandboxDeps } from './drizzle/sandbox.js'
