// Shared vocabulary, pure logic, and port interfaces for @cat-factory/core.

export * from './domain/types'
export {
  DomainError,
  NotFoundError,
  ValidationError,
  ConflictError,
  assertFound,
  type DomainErrorCode,
} from './domain/errors'
export { DEFAULT_CONFIDENCE_THRESHOLD, BLOCK_TYPE_LABEL, TASK_NAME_BANK } from './domain/catalog'
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

export * as atlassianLogic from './shared/atlassian.logic'
export {
  markdownToText,
  buildExcerpt,
} from './shared/markdown.logic'
export {
  normalizeAtlassianBaseUrl,
  assertSafeAtlassianBaseUrl,
} from './shared/atlassian.logic'

export { requireWorkspace } from './workspace-guard'

export {
  type TaskContextView,
  renderTaskContext,
} from './shared/tasks-prompt.logic'
