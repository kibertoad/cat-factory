// Shared vocabulary, pure logic, and port interfaces for @cat-factory/core.

export * from './domain/types'
export {
  DomainError,
  NotFoundError,
  ValidationError,
  ConflictError,
  assertFound,
  getErrorMessage,
  type DomainErrorCode,
} from './domain/errors'
export { sameSubtasks, sameSubtaskItems } from './domain/subtasks.logic'
export { DEFAULT_CONFIDENCE_THRESHOLD, BLOCK_TYPE_LABEL } from './domain/catalog'
export {
  type SelectableModel,
  type ModelVariant,
  type DirectKeyAvailable,
  MODEL_CATALOG,
  getSelectableModel,
  effectiveCatalog,
  resolveModelRef,
} from './domain/models'
export { seedBlocks, seedPipelines, BLUEPRINT_PIPELINE_ID } from './domain/seed'

export * from './ports'

export { MapSourceRegistry } from './shared/source-registry.logic'
export * as atlassianLogic from './shared/atlassian.logic'
export { markdownToText, buildExcerpt } from './shared/markdown.logic'
export { normalizeAtlassianBaseUrl, assertSafeAtlassianBaseUrl } from './shared/atlassian.logic'

export { requireWorkspace } from './workspace-guard'

export { type TaskContextView, renderTaskContext } from './shared/tasks-prompt.logic'
