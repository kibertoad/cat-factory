// ---------------------------------------------------------------------------
// Domain model for the Agent Architecture Board.
//
// These shapes mirror the `@cat-factory/contracts` wire schemas exactly, so a
// payload returned by the backend drops straight into the Pinia stores without
// translation. The board and its agent pipelines are owned by the backend; the
// frontend renders and mutates that state over the REST API.
// ---------------------------------------------------------------------------

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
}

/**
 * A curated best-practice "prompt fragment" served read-only by the backend
 * (`GET /prompt-fragments`). Users pick which apply to a block; the backend folds
 * the selected fragments' bodies into the agent system prompt at run time.
 */
export interface PromptFragment {
  id: string
  version: string
  title: string
  category: string
  summary: string
  body: string
  appliesTo?: {
    blockTypes?: BlockType[]
    agentKinds?: AgentKind[]
  }
}

/** The kinds of agents available in the agent palette. */
export type AgentKind =
  | 'architect'
  | 'researcher'
  | 'coder'
  | 'tester'
  | 'reviewer'
  | 'documenter'
  | 'integrator'

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

/** Runtime state of a single agent within a running execution. */
export type AgentState =
  | 'pending' // not started
  | 'working' // actively (visually) working
  | 'waiting_decision' // paused, needs a human decision
  | 'done' // finished

/** A decision an agent surfaces mid-step that a human must resolve. */
export interface Decision {
  id: string
  question: string
  options: string[]
  chosen: string | null
}

/** One agent's slot in a running pipeline. */
export interface PipelineStep {
  agentKind: AgentKind
  state: AgentState
  /** 0..1 progress of this individual step */
  progress: number
  /** present + unresolved => the step (and block) is blocked */
  decision: Decision | null
  /** text the agent produced for this step (when LLM execution is enabled). */
  output?: string
  /** identifier of the model that produced `output`, for transparency. */
  model?: string
}

/** A pipeline instance running against one block. */
export interface ExecutionInstance {
  id: string
  blockId: string
  pipelineId: string
  pipelineName: string
  steps: PipelineStep[]
  /** index into steps of the currently active step */
  currentStep: number
  /** 'paused' = halted by the spend safeguard until the budget frees up. */
  status: 'running' | 'blocked' | 'done' | 'paused'
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
}

/** Full server-side state of a workspace, returned on load and after resets. */
export interface WorkspaceSnapshot {
  workspace: Workspace
  blocks: Block[]
  pipelines: Pipeline[]
  executions: ExecutionInstance[]
  /**
   * How the server advances runs: 'workflow' (durable, server-driven) or 'tick'
   * (this client drives progress by polling). Absent on older servers → 'tick'.
   */
  executionMode?: 'workflow' | 'tick'
  /** Current spend-safeguard status; absent on older servers. */
  spend?: SpendStatus
}

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
