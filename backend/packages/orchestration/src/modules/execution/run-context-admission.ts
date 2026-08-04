/**
 * The engine's context-building + run-admission pair: the {@link AgentContextBuilder} every
 * dispatch composes its prompt through, and the {@link RunAdmission} preflight family
 * (`assert*`) that start / retry / restart all gate on.
 *
 * Extracted verbatim from the {@link ExecutionService} constructor (which had grown past the
 * per-function line budget — docs/initiatives/lint-complexity-size-ratchet.md) following the
 * same sibling-factory pattern as `gate-window-controllers.ts`: ONE deps object of values the
 * constructor already had in hand, and the two collaborators returned together because admission
 * is built ON the context builder — they are one seam, not two. Behaviour-neutral.
 */

import { AgentContextBuilder } from './AgentContextBuilder.js'
import { RunAdmission } from './RunAdmission.js'
import type { ExecutionServiceDependencies } from './ExecutionService.js'

/**
 * The subset of {@link ExecutionServiceDependencies} the pair reads. Every field is the SAME
 * value the constructor passed inline, so the two collaborators are built from an identical
 * input to before.
 */
export type RunContextAdmissionDeps = Pick<
  ExecutionServiceDependencies,
  | 'workspaceRepository'
  | 'blockRepository'
  | 'executionRepository'
  | 'accountRepository'
  | 'agentKindRegistry'
  | 'initiativePresetRegistry'
  | 'agentPromptRepository'
  | 'consensusGroupRepository'
  | 'documentRepository'
  | 'documentUrlResolver'
  | 'taskRepository'
  | 'requirementReviewRepository'
  | 'docInterviewRepository'
  | 'clarityReviewRepository'
  | 'brainstormSessionRepository'
  | 'initiativeRepository'
  | 'environmentProvisioning'
  | 'resolveTestSecretRefs'
  | 'resolveValidationChecks'
  | 'fragmentResolver'
  | 'skillResolver'
  | 'spendService'
  | 'workspaceSettingsService'
  | 'resolveBinaryArtifactStore'
  | 'resolveProviderCapabilities'
  | 'inlineHarnessRef'
  | 'resolveWorkspaceModelDefault'
  | 'assertAgentBackendConfigured'
  | 'logger'
  | 'workspaceAgentSettingsRepository'
  | 'modelPresetRepository'
  | 'modelPresetCache'
  | 'foundationalServiceResolver'
  | 'binaryGeneratorSource'
>

export function buildRunContextAndAdmission(deps: RunContextAdmissionDeps): {
  contextBuilder: AgentContextBuilder
  admission: RunAdmission
} {
  const contextBuilder = new AgentContextBuilder({
    workspaceRepository: deps.workspaceRepository,
    blockRepository: deps.blockRepository,
    accountRepository: deps.accountRepository,
    agentKindRegistry: deps.agentKindRegistry,
    initiativePresetRegistry: deps.initiativePresetRegistry,
    agentPrompts: deps.agentPromptRepository,
    agentSettings: deps.workspaceAgentSettingsRepository,
    modelPresets: deps.modelPresetRepository,
    modelPresetCache: deps.modelPresetCache,
    consensusGroups: deps.consensusGroupRepository,
    documents: deps.documentRepository,
    documentUrlResolver: deps.documentUrlResolver,
    tasks: deps.taskRepository,
    requirementReviews: deps.requirementReviewRepository,
    docInterviews: deps.docInterviewRepository,
    clarityReviews: deps.clarityReviewRepository,
    brainstormSessions: deps.brainstormSessionRepository,
    initiatives: deps.initiativeRepository,
    environmentProvisioning: deps.environmentProvisioning,
    resolveTestSecretRefs: deps.resolveTestSecretRefs,
    resolveValidationChecks: deps.resolveValidationChecks,
    fragmentResolver: deps.fragmentResolver,
    skillResolver: deps.skillResolver,
    foundationalServiceResolver: deps.foundationalServiceResolver,
    binaryGeneratorSource: deps.binaryGeneratorSource,
    logger: deps.logger,
  })
  // The run-admission preflights (the shared start/retry/restart `assert*` gate family).
  // The admission-only seams are forwarded here rather than stored on the engine.
  const admission = new RunAdmission({
    workspaceRepository: deps.workspaceRepository,
    blockRepository: deps.blockRepository,
    executionRepository: deps.executionRepository,
    contextBuilder,
    agentKindRegistry: deps.agentKindRegistry,
    spend: deps.spendService,
    environmentProvisioning: deps.environmentProvisioning,
    workspaceSettingsService: deps.workspaceSettingsService,
    resolveBinaryArtifactStore: deps.resolveBinaryArtifactStore,
    foundationalServiceResolver: deps.foundationalServiceResolver,
    binaryGeneratorSource: deps.binaryGeneratorSource,
    resolveProviderCapabilities: deps.resolveProviderCapabilities,
    inlineHarnessRef: deps.inlineHarnessRef,
    resolveWorkspaceModelDefault: deps.resolveWorkspaceModelDefault,
    assertAgentBackendConfigured: deps.assertAgentBackendConfigured,
  })
  return { contextBuilder, admission }
}
