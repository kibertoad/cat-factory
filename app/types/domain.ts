// ---------------------------------------------------------------------------
// Domain model for the Agent Architecture Board.
//
// These shapes mirror the `@cat-factory/contracts` wire schemas exactly, so a
// payload returned by the backend drops straight into the Pinia stores without
// translation. The board and its agent pipelines are owned by the backend; the
// frontend renders and mutates that state over the REST API.
//
// This module holds the core board vocabulary. Adjacent concerns live in
// sibling modules and are re-exported below so `~/types/domain` stays the single
// import surface:
//   - execution model  → ./execution
//   - models/fragments  → ./models
//   - document sources  → ./documents
// ---------------------------------------------------------------------------

import type { ExecutionInstance } from './execution'

/** Lifecycle of an architecture building block. */
export type BlockStatus =
  | 'planned' // sketched, no dependencies satisfied yet
  | 'ready' // dependencies done, can be implemented
  | 'in_progress' // a pipeline is (visually) running against it
  | 'blocked' // a pipeline step is waiting on a human decision
  | 'pr_ready' // pipeline finished — a PR is open and awaiting merge
  | 'done' // PR merged, implementation complete

/** Kind of architecture building block (drives icon + accent). */
export type BlockType =
  | 'frontend'
  | 'service'
  | 'api'
  | 'database'
  | 'queue'
  | 'integration'
  | 'external'
  | 'environment'

/**
 * Where a block sits in the granularity hierarchy. Both `frame` and `module`
 * are containers ("frames") that hold draggable tasks:
 *  - `frame`   a top-level Service; the only level rendered as a board node
 *  - `module`  a sub-frame inside a service; created when a task assigned to a
 *              not-yet-existing module is implemented (tasks can also be dragged in)
 *  - `task`    a draggable unit of work living inside a service or a module
 */
export type BlockLevel = 'frame' | 'module' | 'task'

/** A building block dropped on the board. */
export interface Block {
  id: string
  title: string
  type: BlockType
  description: string
  /** position relative to the parent container (service or module). */
  position: { x: number; y: number }
  status: BlockStatus
  /** 0..1 implementation progress, derived from the running execution. */
  progress: number
  /** ids of tasks that must be implemented before this one (drives arrows). */
  dependsOn: string[]
  /** id of the ExecutionInstance currently running against this block, if any. */
  executionId: string | null
  /** granularity level; absent on legacy/persisted data means `frame`. */
  level: BlockLevel
  /** parent container: service or module for a task, service for a module. */
  parentId: string | null
  /** task-only: 0..1 confidence produced when the pipeline finishes. */
  confidence?: number
  /** task-only: auto-merge the PR when confidence ≥ this threshold (0..1). */
  confidenceThreshold?: number
  /** task-only: the module this task belongs to (created on implement if absent). */
  moduleName?: string
  /** task-only: the features this task implements (definition metadata). */
  features?: string[]
  /** ids of best-practice prompt fragments folded into this block's agent prompts. */
  fragmentIds?: string[]
  /** id of the model (from MODEL_CATALOG) to run this block's agents with; absent = default. */
  modelId?: string
  /** where this block's acceptance / Playwright tests run; absent = no preference. */
  testTarget?: TestTarget
  /** the PR the block's implementer agent opened for its work; absent = none yet. */
  pullRequest?: PullRequestRef
}

/**
 * A lightweight link from a block to the pull request its implementer agent
 * opened. Just enough to display the PR on the board and navigate to it; mirrors
 * `PullRequestRef` in `@cat-factory/contracts`.
 */
export interface PullRequestRef {
  /** The PR's web URL, opened when the user clicks through from the board. */
  url: string
  /** The PR number within the repo, shown as `#<number>` when known. */
  number?: number
  /** The head branch the agent pushed its work to, when known. */
  branch?: string
}

/**
 * Where a block's acceptance / Playwright tests run:
 *  - `github_actions`  in the project's CI, against a service spun up in the run
 *  - `ephemeral_env`   against the provisioned ephemeral environment for the run
 */
export type TestTarget = 'github_actions' | 'ephemeral_env'

/** The kinds of agents available in the agent palette. */
export type AgentKind =
  | 'architect'
  | 'researcher'
  | 'coder'
  | 'tester'
  | 'reviewer'
  | 'documenter'
  | 'integrator'
  | 'acceptance'
  | 'playwright'
  | 'mocker'
  | 'business-documenter'
  | 'business-reviewer'

/** A draggable agent definition shown in the agent palette. */
export interface AgentArchetype {
  kind: AgentKind
  label: string
  /** iconify name (lucide) */
  icon: string
  /** tailwind-ish accent token used across chips / borders */
  color: string
  description: string
}

/** A reusable, linear sequence of agents. */
export interface Pipeline {
  id: string
  name: string
  /** ordered agent kinds — the chain executes left to right */
  agentKinds: AgentKind[]
}

/**
 * Spend-safeguard status for the current billing period (a calendar month).
 * Token usage is priced into a single currency and gated by a budget; once
 * `exceeded`, runs are paused and the frontend shows a large warning.
 */
export interface SpendStatus {
  /** Start of the current billing period (epoch ms). */
  periodStart: number
  inputTokens: number
  outputTokens: number
  /** Estimated spend this period, in `currency`. */
  costSpent: number
  /** Configured budget for one period, in `currency`. */
  costLimit: number
  /** ISO 4217 currency (e.g. 'EUR'). */
  currency: string
  /** True once the budget is reached: execution is paused. */
  exceeded: boolean
}

/** A board/project container owned by the backend. */
export interface Workspace {
  id: string
  name: string
  createdAt: number
  /** The account this board belongs to, or null for a legacy/unscoped board. */
  accountId: string | null
}

/** Full server-side state of a workspace, returned on load and after resets. */
export interface WorkspaceSnapshot {
  workspace: Workspace
  blocks: Block[]
  pipelines: Pipeline[]
  executions: ExecutionInstance[]
  /** Current spend-safeguard status; absent on older servers. */
  spend?: SpendStatus
}

/**
 * Real-time events pushed over the workspace WebSocket stream (see
 * `useWorkspaceStream`). Mirrors `WorkspaceEvent` in `@cat-factory/contracts`.
 */
export type WorkspaceEvent =
  | { type: 'execution'; instance: ExecutionInstance; block: Block | null; at: number }
  | { type: 'board'; reason: string; at: number }

/** Level-of-detail buckets driven by the canvas zoom level. */
export type LodLevel = 'far' | 'mid' | 'close'

/** The signed-in GitHub user, as returned by the backend's /auth/me. */
export interface AuthUser {
  /** GitHub user id (stable across renames). */
  id: number
  login: string
  name: string | null
  avatarUrl: string | null
}

// Re-export the adjacent domain modules so `~/types/domain` remains the single
// import surface for the whole frontend.
export type * from './execution'
export type * from './models'
export type * from './documents'
export type * from './tasks'
export type * from './scenarios'
export type * from './bootstrap'
export type * from './github'
export type * from './accounts'
