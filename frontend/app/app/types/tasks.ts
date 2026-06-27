// ---------------------------------------------------------------------------
// Task-source integration. Individual issues imported from external task
// trackers (Jira, …) can be attached to a board task as agent context. These
// mirror the `@cat-factory/contracts` task schemas; the abstraction is
// source-agnostic, keyed by `source`. Unlike document sources there is no
// plan/spawn — an issue is linked for context, never expanded into structure.
// ---------------------------------------------------------------------------
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  TaskSourceKind,
  TaskSourceDescriptor,
  TaskSourceState,
  TaskSourceDiagnosticStatus,
  TaskSourceDiagnostic,
  TaskConnection,
  TaskComment,
  SourceTask,
  TaskSearchResult,
  CredentialField,
} from '@cat-factory/contracts'
