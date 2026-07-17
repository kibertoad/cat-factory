// Barrel for the Drizzle/Postgres core repositories. The concrete port
// implementations are split by domain under ./drizzle/*; this module assembles them
// into the CoreRepositories set and re-exports the handful consumed directly by
// callers (index.ts, container.ts, the test harness). Split out of a single
// ~5,000-line module — see docs/refactoring-candidates.md #1.

import type {
  AccountInvitationRepository,
  AccountRepository,
  AccountSettingsRepository,
  AgentContextSnapshotRepository,
  AgentRunRepository,
  AgentSearchQueryRepository,
  BinaryArtifactMetadataStore,
  BlockRepository,
  BrainstormSessionRepository,
  ClarityReviewRepository,
  Clock,
  ConsensusSessionRepository,
  DocInterviewRepository,
  EmailConnectionRepository,
  ExecutionRepository,
  IncidentEnrichmentConnectionRepository,
  InitiativeRepository,
  KaizenGradingRepository,
  KaizenVerifiedComboRepository,
  LlmCallMetricRepository,
  MembershipRepository,
  ModelPresetRepository,
  ObservabilityConnectionRepository,
  PackageRegistryConnectionRepository,
  PasswordResetTokenRepository,
  PipelineRepository,
  PipelineScheduleRepository,
  PlatformMetricsRepository,
  ProvisioningLogRepository,
  ReleaseHealthConfigRepository,
  RequirementReviewRepository,
  RiskPolicyRepository,
  ServiceFragmentDefaultsRepository,
  ServiceRepository,
  SharedStackRepository,
  SubscriptionQuotaCycleRepository,
  TestSecretsRepository,
  TokenUsageRepository,
  TrackerSettingsRepository,
  UserRepository,
  UserSettingsRepository,
  WorkspaceMountRepository,
  WorkspaceRepository,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'

import type { DrizzleDb } from '../db/client.js'

import {
  DrizzleBlockRepository,
  DrizzleServiceFragmentDefaultsRepository,
  DrizzleServiceRepository,
  DrizzleWorkspaceMountRepository,
  DrizzleWorkspaceRepository,
} from './drizzle/board.js'

import {
  DrizzleAgentRunRepository,
  DrizzleExecutionRepository,
  DrizzlePipelineRepository,
  DrizzlePipelineScheduleRepository,
  DrizzlePlatformMetricsRepository,
} from './drizzle/execution.js'

import {
  DrizzleAccountInvitationRepository,
  DrizzleAccountRepository,
  DrizzleEmailConnectionRepository,
  DrizzleMembershipRepository,
  DrizzlePasswordResetTokenRepository,
  DrizzleUserRepository,
} from './drizzle/accounts.js'

import {
  DrizzleAgentContextSnapshotRepository,
  DrizzleAgentSearchQueryRepository,
  DrizzleBinaryArtifactMetadataStore,
  DrizzleLlmCallMetricRepository,
  DrizzleProvisioningLogRepository,
  DrizzleTokenUsageRepository,
} from './drizzle/telemetry.js'

import {
  DrizzleAccountSettingsRepository,
  DrizzleModelPresetRepository,
  DrizzleTrackerSettingsRepository,
  DrizzleUserSettingsRepository,
  DrizzleWorkspaceSettingsRepository,
} from './drizzle/settings.js'

import {
  DrizzleBrainstormSessionRepository,
  DrizzleClarityReviewRepository,
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
  DrizzleIncidentEnrichmentConnectionRepository,
  DrizzleObservabilityConnectionRepository,
  DrizzlePackageRegistryConnectionRepository,
  DrizzleReleaseHealthConfigRepository,
  DrizzleSubscriptionQuotaCycleRepository,
  DrizzleTestSecretsRepository,
} from './drizzle/connections.js'

export interface CoreRepositories {
  workspaceRepository: WorkspaceRepository
  accountRepository: AccountRepository
  membershipRepository: MembershipRepository
  userRepository: UserRepository
  invitationRepository: AccountInvitationRepository
  passwordResetTokenRepository: PasswordResetTokenRepository
  emailConnectionRepository: EmailConnectionRepository
  blockRepository: BlockRepository
  pipelineRepository: PipelineRepository
  executionRepository: ExecutionRepository
  tokenUsageRepository: TokenUsageRepository
  llmCallMetricRepository: LlmCallMetricRepository
  agentContextSnapshotRepository: AgentContextSnapshotRepository
  agentSearchQueryRepository: AgentSearchQueryRepository
  binaryArtifactMetadataStore: BinaryArtifactMetadataStore
  agentRunRepository: AgentRunRepository
  platformMetricsRepository: PlatformMetricsRepository
  modelPresetRepository: ModelPresetRepository
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
  clarityReviewRepository: ClarityReviewRepository
  brainstormSessionRepository: BrainstormSessionRepository
  initiativeRepository: InitiativeRepository
  riskPolicyRepository: RiskPolicyRepository
  sharedStackRepository: SharedStackRepository
  workspaceSettingsRepository: WorkspaceSettingsRepository
  userSettingsRepository: UserSettingsRepository
  observabilityConnectionRepository: ObservabilityConnectionRepository
  packageRegistryConnectionRepository: PackageRegistryConnectionRepository
  incidentEnrichmentConnectionRepository: IncidentEnrichmentConnectionRepository
  accountSettingsRepository: AccountSettingsRepository
  releaseHealthConfigRepository: ReleaseHealthConfigRepository
  subscriptionQuotaCycleRepository: SubscriptionQuotaCycleRepository
  testSecretsRepository: TestSecretsRepository
  provisioningLogRepository: ProvisioningLogRepository
}

/** Build the Drizzle/Postgres-backed core repositories. */
export function createDrizzleRepositories(db: DrizzleDb, clock: Clock): CoreRepositories {
  return {
    workspaceRepository: new DrizzleWorkspaceRepository(db),
    accountRepository: new DrizzleAccountRepository(db),
    membershipRepository: new DrizzleMembershipRepository(db),
    userRepository: new DrizzleUserRepository(db),
    invitationRepository: new DrizzleAccountInvitationRepository(db),
    passwordResetTokenRepository: new DrizzlePasswordResetTokenRepository(db),
    emailConnectionRepository: new DrizzleEmailConnectionRepository(db),
    blockRepository: new DrizzleBlockRepository(db),
    pipelineRepository: new DrizzlePipelineRepository(db),
    executionRepository: new DrizzleExecutionRepository(db, clock),
    tokenUsageRepository: new DrizzleTokenUsageRepository(db),
    llmCallMetricRepository: new DrizzleLlmCallMetricRepository(db),
    agentContextSnapshotRepository: new DrizzleAgentContextSnapshotRepository(db),
    agentSearchQueryRepository: new DrizzleAgentSearchQueryRepository(db),
    binaryArtifactMetadataStore: new DrizzleBinaryArtifactMetadataStore(db),
    agentRunRepository: new DrizzleAgentRunRepository(db),
    platformMetricsRepository: new DrizzlePlatformMetricsRepository(db),
    modelPresetRepository: new DrizzleModelPresetRepository(db),
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
    clarityReviewRepository: new DrizzleClarityReviewRepository(db),
    brainstormSessionRepository: new DrizzleBrainstormSessionRepository(db),
    initiativeRepository: new DrizzleInitiativeRepository(db),
    riskPolicyRepository: new DrizzleRiskPolicyRepository(db),
    sharedStackRepository: new DrizzleSharedStackRepository(db),
    workspaceSettingsRepository: new DrizzleWorkspaceSettingsRepository(db),
    userSettingsRepository: new DrizzleUserSettingsRepository(db),
    observabilityConnectionRepository: new DrizzleObservabilityConnectionRepository(db),
    packageRegistryConnectionRepository: new DrizzlePackageRegistryConnectionRepository(db),
    incidentEnrichmentConnectionRepository: new DrizzleIncidentEnrichmentConnectionRepository(db),
    accountSettingsRepository: new DrizzleAccountSettingsRepository(db),
    releaseHealthConfigRepository: new DrizzleReleaseHealthConfigRepository(db),
    subscriptionQuotaCycleRepository: new DrizzleSubscriptionQuotaCycleRepository(db),
    testSecretsRepository: new DrizzleTestSecretsRepository(db),
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
  DrizzleLocalSettingsRepository,
  DrizzleWorkspaceSettingsRepository,
} from './drizzle/settings.js'
export {
  DrizzleClarityReviewRepository,
  DrizzleDocInterviewRepository,
  DrizzleRequirementReviewRepository,
} from './drizzle/reviews.js'
export { createDrizzleSandboxDeps } from './drizzle/sandbox.js'
export { DrizzleTestSecretsRepository } from './drizzle/connections.js'
