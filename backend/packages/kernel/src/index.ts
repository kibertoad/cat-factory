// Shared vocabulary, pure logic, and port interfaces for the domain packages
// (@cat-factory/orchestration, @cat-factory/integrations, …).

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
export { BLOCK_TYPE_LABEL, DEFAULT_MERGE_PRESET, DEFAULT_CI_MAX_ATTEMPTS } from './domain/catalog'
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
