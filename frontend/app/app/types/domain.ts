// ---------------------------------------------------------------------------
// Domain model for the Agent Architecture Board.
//
// The wire shapes are owned by `@cat-factory/contracts` and re-exported here, so
// a payload returned by the backend drops straight into the Pinia stores without
// translation. This module re-exports the core board vocabulary from the
// contracts package and adds the few genuinely frontend-only types (palette
// presentation, level-of-detail, the signed-in user view) on top.
//
// Adjacent concerns live in sibling modules and are re-exported below so
// `~/types/domain` stays the single import surface:
//   - execution model  → ./execution
//   - models/fragments  → ./models
//   - document sources  → ./documents
// ---------------------------------------------------------------------------

// Wire types sourced from the contracts package (single source of truth).
export type {
  BlockStatus,
  BlockType,
  FrameRepoType,
  BlockLevel,
  TaskType,
  CreateTaskType,
  TaskTypeFields,
  DocKind,
  DocKindFieldKey,
  DocKindFieldSpec,
  Block,
  PullRequestRef,
  ReferenceRepo,
  AprioriBranch,
  CloudProvider,
  InstanceSize,
  ProvisionType,
  ServiceProvisioning,
  FrontendConfig,
  FrontendBackendBinding,
  FrontendBackendSource,
  ResolvedFrontendBinding,
  EnvironmentHandle,
  EnvironmentTestRun,
  EnvironmentTestStage,
  EnvironmentTestStatus,
  ServiceConnection,
  FrontendBranch,
  FrontendPackageManager,
  FrontendServeMode,
  FrontendEnvInjection,
  FrontendConfigRecommendation,
  FrontendDetectionNote,
  AgentConfigOption,
  AgentConfigDescriptor,
  TestConcernSeverity,
  TestConcern,
  TestOutcome,
  TestReport,
  TestScreenshot,
  AgentKind,
  AgentCategory,
  CustomAgentKind,
  CustomTaskType,
  TaskTypePresentation,
  TaskTypeFieldDescriptor,
  TaskTypeFieldOption,
  Pipeline,
  PipelinePurpose,
  SpendStatus,
  BudgetCaps,
  Workspace,
  WorkspaceListItem,
  WorkspaceSnapshot,
  WorkspaceRole,
  WorkspacePermission,
  WorkspaceAccessMode,
  WorkspaceAccess,
  WorkspaceMember,
  TaskLimitMode,
  ReviewFrictionMode,
  WorkspaceSettings,
  UpdateWorkspaceSettingsInput,
  UserSettings,
  UpdateUserSettingsInput,
  InfraSetup,
  InfraSetupStatus,
  InfraSetupArea,
  ServiceFragmentDefaults,
  KaizenGradingStatus,
  KaizenGrading,
  KaizenVerifiedCombo,
  KaizenOverview,
  WorkspaceEvent,
  PreviewState,
  PreviewStatus,
} from '@cat-factory/contracts'

import type { AgentCategory, AgentKind } from '@cat-factory/contracts'

// The document-kind list + the per-kind field descriptors are runtime values (used to render
// the picker and the conditional per-kind inputs), so they are re-exported as values — the
// single source of truth lives in the contracts package.
export { DOC_KINDS, DOC_KIND_FIELDS } from '@cat-factory/contracts'

/** A draggable agent definition shown in the agent palette. Frontend-only. */
export interface AgentArchetype {
  kind: AgentKind
  label: string
  /** iconify name (lucide) */
  icon: string
  /** tailwind-ish accent token used across chips / borders */
  color: string
  description: string
  /** Palette category this archetype is grouped under. Absent ⇒ ungrouped/system kind. */
  category?: AgentCategory
  /**
   * Optional id of a DEDICATED result window this agent's step opens instead of the
   * generic prose step-detail panel. Resolved through the modular `resultViews` slot
   * registry (`~/modular/result-views`, read by `StepResultViewHost`) so any agent —
   * built-in or a consumer's — can declare a bespoke visualization without the renderer
   * hardcoding a kind. Absent → the generic `AgentStepDetail` panel.
   */
  resultView?: string
}

/**
 * Display metadata for a task TYPE (the card badge + create-task picker), resolved through the
 * `taskTypeMeta` read-model. A BUILT-IN type carries an i18n {@link labelKey}; a CUSTOM
 * (deployment-registered) type carries a literal {@link label} from the wire presentation. The
 * renderer resolves the display string as `labelKey ? t(labelKey) : label`. Frontend-only.
 */
export interface TaskTypeMeta {
  /** The task type id this meta describes. */
  taskType: string
  /** iconify name (lucide). */
  icon: string
  /** tailwind-ish accent token used across the card badge / picker. */
  color: string
  /** i18n key for a BUILT-IN type's label; absent for a custom type. */
  labelKey?: string
  /** Literal label for a CUSTOM type (from the wire presentation); absent for a built-in. */
  label?: string
}

/** Level-of-detail buckets driven by the canvas zoom level. Shallow → deep:
 * `far`/`mid`/`close` govern a service frame (chip → card → opened with tasks);
 * `steps`/`subtasks` drill spatially into an individual task — revealing its
 * build-pipeline steps, then each step's live todo breakdown. Frontend-only. */
export type LodLevel = 'far' | 'mid' | 'close' | 'steps' | 'subtasks'

/**
 * The signed-in user, as returned by the backend's /auth/me. The backend's
 * session-user id is an internal `usr_*` string (NOT the GitHub numeric id).
 */
export interface AuthUser {
  /** Internal user id (`usr_*`). */
  id: string
  login: string
  name: string | null
  avatarUrl: string | null
  email?: string | null
}

// Re-export the adjacent domain modules so `~/types/domain` remains the single
// import surface for the whole frontend.
export type * from './execution'
export type * from './models'
export type * from './fragments'
export type * from './skills'
export type * from './documents'
export type * from './tasks'
export type * from './bootstrap'
export type * from './envConfigRepair'
export type * from './github'
export type * from './accounts'
export type * from './notifications'
export type * from './slack'
export type * from './merge'
export type * from './services'
export type * from './recurring'
export type * from './tracker'
export type * from './initiative'
export type * from './doc-interview'
