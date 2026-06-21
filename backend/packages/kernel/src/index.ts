// Shared vocabulary, pure logic, and port interfaces for the domain packages
// (@cat-factory/orchestration, @cat-factory/integrations, …).

export * from './domain/types.js'
export {
  DomainError,
  NotFoundError,
  ValidationError,
  ConflictError,
  assertFound,
  getErrorMessage,
  type DomainErrorCode,
} from './domain/errors.js'
export { sameSubtasks, sameSubtaskItems } from './domain/subtasks.logic.js'
export {
  BLOCK_TYPE_LABEL,
  DEFAULT_MERGE_PRESET,
  DEFAULT_CI_MAX_ATTEMPTS,
} from './domain/catalog.js'
export {
  type SelectableModel,
  type ModelVariant,
  type SubscriptionVariant,
  type SubscriptionVendorConfig,
  type DirectKeyAvailable,
  type ModelCostResolver,
  MODEL_CATALOG,
  SUBSCRIPTION_VENDORS,
  getSelectableModel,
  effectiveCatalog,
  resolveModelRef,
  subscriptionOptionFor,
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

export * from './ports/index.js'

export {
  type ServiceRegistrationDeps,
  registerServiceForFrame,
} from './domain/service-registration.js'

export { MapSourceRegistry } from './shared/source-registry.logic.js'
export * as atlassianLogic from './shared/atlassian.logic.js'
export { markdownToText, buildExcerpt } from './shared/markdown.logic.js'
export { normalizeAtlassianBaseUrl, assertSafeAtlassianBaseUrl } from './shared/atlassian.logic.js'

export { requireWorkspace } from './workspace-guard.js'

export { type TaskContextView, renderTaskContext } from './shared/tasks-prompt.logic.js'
