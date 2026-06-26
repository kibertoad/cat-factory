// Shared vocabulary, pure logic, and port interfaces for the domain packages
// (@cat-factory/orchestration, @cat-factory/integrations, …).

export * from './domain/types.js'
export {
  DomainError,
  NotFoundError,
  ValidationError,
  ConflictError,
  CredentialRequiredError,
  assertFound,
  getErrorMessage,
  type DomainErrorCode,
  type CredentialRequiredReason,
  type ConflictReason,
} from './domain/errors.js'
export { sameSubtasks, sameSubtaskItems } from './domain/subtasks.logic.js'
export { resolveWritebackFlag } from './domain/writeback.js'
export { extractJson } from './domain/llm-output.js'
export {
  BLOCK_TYPE_LABEL,
  DEFAULT_MERGE_PRESET,
  DEFAULT_CI_MAX_ATTEMPTS,
  DEFAULT_MAX_REQUIREMENT_ITERATIONS,
  CONTEXT_BUDGET,
  DEFAULT_WORKSPACE_SETTINGS,
  DEFAULT_MODEL_PRESETS,
  DEFAULT_MODEL_PRESET,
  modelForKindFromPreset,
  type ModelPresetSeed,
} from './domain/catalog.js'
export {
  type SelectableModel,
  type ModelVariant,
  type SubscriptionVariant,
  type SubscriptionVendorConfig,
  type ProviderCapabilities,
  type ModelCostResolver,
  MODEL_CATALOG,
  SUBSCRIPTION_VENDORS,
  ALL_SUBSCRIPTION_VENDORS,
  getSelectableModel,
  contextWindowFor,
  effectiveCatalog,
  effectiveCatalogWith,
  type LocalEndpointModels,
  localSelectableModels,
  parseLocalModelId,
  openRouterSelectableModels,
  parseOpenRouterModelId,
  resolveModelRef,
  isModelUsable,
  subscriptionOptionFor,
  isIndividualVendor,
  INDIVIDUAL_VENDORS,
  individualVendorForModelId,
  personalCredentialVendorForModelId,
} from './domain/models.js'
export {
  seedBlocks,
  seedPipelines,
  BLUEPRINT_PIPELINE_ID,
  DEP_UPDATE_PIPELINE_ID,
  TECH_DEBT_PIPELINE_ID,
} from './domain/seed.js'
// Installation-level extension point for predefined pipelines (mirrors the custom
// agent-kind / model-provider registry seams): a deployment registers extra pipelines at
// startup and `seedPipelines()` seeds them into every new workspace.
export {
  registerPipeline,
  registerPipelines,
  registeredPipelines,
  clearRegisteredPipelines,
} from './domain/pipeline-registry.js'

// Installation-level extension point for custom polling gates + step-completion
// resolvers (mirrors the agent-kind / pipeline registry seams): a deployment registers
// its own gate / resolver at startup and the ExecutionService merges them with the
// built-ins. See `domain/gate-registry.ts` / `domain/step-resolver-registry.ts`.
export {
  type GateProbe,
  type GateHelperOutcome,
  type GateHelperJobResult,
  type GateHelperCompletionArgs,
  type GateExhaustedArgs,
  type GateDefinition,
  type GateContext,
  type GateFactory,
  recordGateAttempt,
  registerGate,
  registeredGateFactories,
  clearRegisteredGates,
  stubGateContext,
} from './domain/gate-registry.js'
export {
  type StepResolverContext,
  type StepResolution,
  type StepCompletionResolver,
  type ResolverContext,
  type StepResolverFactory,
  registerStepResolver,
  registeredStepResolverFactories,
  clearRegisteredStepResolvers,
  stubResolverContext,
} from './domain/step-resolver-registry.js'

// Typed provider registry: the deployment-supplied data sources a gate (or other
// extension) probes, keyed by an opaque {@link ProviderToken}. Replaces the per-provider
// module-global wire/get boilerplate. See `domain/provider-registry.ts`.
export {
  type ProviderToken,
  defineProviderToken,
  wireProvider,
  getProvider,
  isProviderWired,
  requireProvider,
  clearProviders,
} from './domain/provider-registry.js'

// Pure gate logic + gate/helper agent-kind constants, shared by the built-in gate suite
// (`@cat-factory/gates`) and the engine. See `domain/gate-logic.ts`.
export {
  CI_AGENT_KIND,
  CI_FIXER_AGENT_KIND,
  CONFLICTS_AGENT_KIND,
  CONFLICT_RESOLVER_AGENT_KIND,
  POST_RELEASE_HEALTH_AGENT_KIND,
  ON_CALL_AGENT_KIND,
  HUMAN_REVIEW_AGENT_KIND,
  FIXER_AGENT_KIND,
  type CiVerdict,
  type ReleaseGateVerdict,
  aggregateCi,
  isCiGreen,
  listFailingChecks,
  describeFailingChecks,
  classifyReleaseHealth,
  describeRegressedSignals,
  renderReleaseEvidence,
} from './domain/gate-logic.js'

export * from './ports/index.js'

export {
  type ServiceRegistrationDeps,
  registerServiceForFrame,
} from './domain/service-registration.js'

export { MapSourceRegistry } from './shared/source-registry.logic.js'
export * as atlassianLogic from './shared/atlassian.logic.js'
export {
  markdownToText,
  buildExcerpt,
  estimateTokens,
  contentHash,
} from './shared/markdown.logic.js'
export { normalizeAtlassianBaseUrl, assertSafeAtlassianBaseUrl } from './shared/atlassian.logic.js'
export { normalizeUrl, urlMatchCandidates } from './shared/url.logic.js'

export { requireWorkspace } from './workspace-guard.js'

export { type TaskContextView, renderTaskContext } from './shared/tasks-prompt.logic.js'
