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
  RequirementVerdict,
  RequirementVerdictStatus,
  TestScreenshot,
  AgentKind,
  AgentCategory,
  AgentTier,
  CustomAgentKind,
  AgentKindVariant,
  CustomTaskType,
  TaskTypePresentation,
  TaskTypeFieldDescriptor,
  TaskTypeFieldOption,
  // One row of the workspace's operation-suppression screen: a registered custom task type plus
  // whether THIS board hides it (`backend/docs/reusable-operations.md`).
  TaskTypeSuppression,
  // The shared descriptor-driven form vocabulary (`contracts/src/form-fields.ts`): one field
  // shape and one filled-value bag behind both the initiative-preset form and a custom task
  // type's per-case form, so `DescriptorFields.vue` renders either.
  DescriptorField,
  DescriptorFieldValue,
  DescriptorFieldValues,
  // Per-step GATE configuration: who may resolve a human approval gate, how many of them, and
  // the parameters the step's registered gate declares (`contracts/src/gate-config.ts`).
  GateApproverPolicy,
  GateConfigForm,
  StepGateConfig,
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
  InputGateMode,
  ReviewFrictionMode,
  WorkspaceSettings,
  WorkspaceMetadata,
  UpdateWorkspaceSettingsInput,
  UserSettings,
  UpdateUserSettingsInput,
  TutorialProgress,
  UpdateTutorialProgressInput,
  RecordTutorialEventInput,
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

import type { AgentCategory, AgentKind, AgentTier, PipelinePurpose } from '@cat-factory/contracts'

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
   * The pipeline PURPOSES the palette offers this kind to, WITHIN the ones its {@link category}
   * already admits (`purposeSuggestsAgentKind`). Absent ⇒ the category alone decides, which is
   * the normal case: declare this only to opt OUT of a purpose the category would admit.
   */
  purposes?: readonly PipelinePurpose[]
  /**
   * How specialist this kind is — the tier the palette / model-preset override list filter on
   * (`basic` shows only basic kinds, `intermediate` adds those, `advanced` shows everything).
   * Absent ⇒ `DEFAULT_AGENT_TIER`, which is how an unclassified deployment kind behaves.
   */
  tier?: AgentTier
  /**
   * Optional id of a DEDICATED result window this agent's step opens instead of the
   * generic prose step-detail panel. Resolved through the modular `resultViews` slot
   * registry (`~/modular/result-views`, read by `StepResultViewHost`) so any agent —
   * built-in or a consumer's — can declare a bespoke visualization without the renderer
   * hardcoding a kind. Absent → the generic `AgentStepDetail` panel.
   */
  resultView?: string
  /**
   * The kind carries the `binary-output` trait: its deliverable is binary artifacts stored
   * through a foundational service, so a step of this kind REQUIRES a `stepOptions.binaryOutput`
   * selection and is refused at pipeline save and at run start without one. Projected onto the
   * snapshot as `CustomAgentKind.binaryOutput` — the only trait with a UI consequence, and the
   * only way the builder can know which steps must offer the storage picker. Absent ⇒ false,
   * which is every built-in kind.
   */
  binaryOutput?: boolean
  /**
   * The platform dispatches this kind for a flow of its own, so the builder palette never offers
   * it as a placeable block (`narrowAgentPalette` drops it). It still resolves through
   * `agentKindMeta`, because a run of it has to RENDER. Absent ⇒ an ordinary palette block.
   */
  internal?: boolean
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
export type * from './foundationalServices'
export type * from './documents'
export type * from './tasks'
export type * from './bugHunt'
export type * from './bootstrap'
export type * from './envConfigRepair'
export type * from './github'
export type * from './vcs'
export type * from './accounts'
export type * from './notifications'
export type * from './slack'
export type * from './merge'
export type * from './services'
export type * from './recurring'
export type * from './tracker'
export type * from './initiative'
export type * from './doc-interview'
