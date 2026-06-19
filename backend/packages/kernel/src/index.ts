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
  type DirectKeyAvailable,
  MODEL_CATALOG,
  getSelectableModel,
  effectiveCatalog,
  resolveModelRef,
} from './domain/models.js'
export { seedBlocks, seedPipelines, BLUEPRINT_PIPELINE_ID } from './domain/seed.js'

export * from './ports/index.js'

export { MapSourceRegistry } from './shared/source-registry.logic.js'
export * as atlassianLogic from './shared/atlassian.logic.js'
export { markdownToText, buildExcerpt } from './shared/markdown.logic.js'
export { normalizeAtlassianBaseUrl, assertSafeAtlassianBaseUrl } from './shared/atlassian.logic.js'

export { requireWorkspace } from './workspace-guard.js'

export { type TaskContextView, renderTaskContext } from './shared/tasks-prompt.logic.js'
