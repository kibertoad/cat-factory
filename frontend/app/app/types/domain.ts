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
  Block,
  PullRequestRef,
  CloudProvider,
  InstanceSize,
  ProvisionType,
  ServiceProvisioning,
  FrontendConfig,
  FrontendBackendBinding,
  FrontendBackendSource,
  FrontendBranch,
  FrontendPackageManager,
  FrontendServeMode,
  FrontendEnvInjection,
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
  Pipeline,
  SpendStatus,
  Workspace,
  WorkspaceSnapshot,
  TaskLimitMode,
  WorkspaceSettings,
  UpdateWorkspaceSettingsInput,
  ServiceFragmentDefaults,
  KaizenGradingStatus,
  KaizenGrading,
  KaizenVerifiedCombo,
  KaizenOverview,
  WorkspaceEvent,
} from '@cat-factory/contracts'

import type { AgentCategory, AgentKind } from '@cat-factory/contracts'

// The document-kind list is a runtime value (used to render the picker), so it is re-exported
// as a value — the single source of truth lives in the contracts package.
export { DOC_KINDS } from '@cat-factory/contracts'

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
   * generic prose step-detail panel. Resolved through the result-view registry
   * (`STEP_RESULT_VIEWS`) so any agent can declare a bespoke visualization without the
   * renderer hardcoding a kind. Absent → the generic `AgentStepDetail` panel.
   */
  resultView?: string
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
