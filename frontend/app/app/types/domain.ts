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
import type { BootstrapJob } from './bootstrap'
import type { Notification } from './notifications'
import type { MergeThresholdPreset } from './merge'
import type { PipelineSchedule } from './recurring'
import type { Service, WorkspaceMount } from './services'
import type { TrackerSettings } from './tracker'

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
  /**
   * Explicit, user-dragged pixel size for a resizable frame (Miro-style border
   * drag). Absent = the board auto-sizes the frame from its contents; present =
   * the dragged size, never shrunk below the content's natural extent.
   */
  size?: { w: number; h: number }
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
  /** task-only: the module this task belongs to (created on implement if absent). */
  moduleName?: string
  /** ids of best-practice prompt fragments folded into this block's agent prompts. */
  fragmentIds?: string[]
  /**
   * frame-only: the service's selected best-practice fragment ids. Folded into the
   * prompt of every `code-aware` agent on tasks under this service. Seeded from the
   * workspace default on new services; absent = none.
   */
  serviceFragmentIds?: string[]
  /** id of the model (from MODEL_CATALOG) to run this block's agents with; absent = default. */
  modelId?: string
  /** the PR the block's implementer agent opened for its work; absent = none yet. */
  pullRequest?: PullRequestRef
  /** task-only: selected merge threshold preset id; absent = workspace default. */
  mergePresetId?: string
  /** task-only: pinned default pipeline id picked at creation; absent = none. */
  pipelineId?: string
  /** task-only: agent-contributed config values (id→value), e.g. the Tester's environment. */
  agentConfig?: Record<string, string>
  /** service-only (frame): docker-compose path for the Tester's local infra; absent = none. */
  testComposePath?: string
  /** service-only (frame): the service has no infra dependencies to stand up. */
  noInfraDependencies?: boolean
  /** service-only (frame): cloud provider the service's jobs run on; absent = account default. */
  cloudProvider?: CloudProvider
  /** service-only (frame): abstract instance size for the service's jobs; absent = default. */
  instanceSize?: InstanceSize
  /** GitHub user id of the task's creator; drives "notify the task creator" routing. */
  createdBy?: number | null
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

/** The cloud provider a service's container jobs run on (per service; account default otherwise). */
export type CloudProvider = 'cloudflare' | 'docker' | 'aws' | 'gcp' | 'azure' | 'custom'

/** Abstract, cloud-neutral instance size selectable per service. */
export type InstanceSize = 'small' | 'medium' | 'large' | 'xlarge'

/** One choice of a `select` agent-config descriptor. */
export interface AgentConfigOption {
  value: string
  label: string
}

/** A task-level configuration parameter an agent kind contributes (see the snapshot catalog). */
export interface AgentConfigDescriptor {
  id: string
  agentKind: string
  label: string
  description: string
  type: 'select'
  options: AgentConfigOption[]
  default: string
}

/** Severity of a Tester-raised concern. */
export type TestConcernSeverity = 'low' | 'medium' | 'high' | 'critical'

/** A bug/risk the Tester surfaced. */
export interface TestConcern {
  title: string
  detail: string
  severity: TestConcernSeverity
}

/** A per-area Tester result. */
export interface TestOutcome {
  name: string
  status: 'passed' | 'failed' | 'skipped'
  detail?: string
}

/** A Tester's structured report (what was tested, outcomes, concerns, greenlight). */
export interface TestReport {
  greenlight: boolean
  summary: string
  tested: string[]
  outcomes: TestOutcome[]
  concerns: TestConcern[]
  environment?: 'local' | 'ephemeral'
}

/** The kinds of agents available in the agent palette. */
export type AgentKind =
  | 'requirements-review'
  | 'architect'
  | 'researcher'
  | 'coder'
  | 'tester'
  // `reviewer` is the coder's companion: it rates the change and loops it back for
  // automatic rework below the quality threshold (see companions below).
  | 'reviewer'
  | 'documenter'
  | 'integrator'
  | 'playwright'
  | 'mocker'
  | 'business-documenter'
  | 'business-reviewer'
  // Companion agents: they grade a prior producer step's output (0..1), loop it back
  // for automatic rework below threshold, then raise the human gate on a pass.
  | 'architect-companion'
  | 'spec-companion'
  // Engine-driven "system" kinds: not user-addable palette archetypes, but they
  // appear in seeded pipelines and run timelines. The spec-writer (aggregates every
  // task's clarified requirements + acceptance scenarios into the service's in-repo
  // `spec/` document before the coder runs), the blueprint mapper, the conflicts gate
  // + its resolver, the CI gate (a special non-LLM step that polls checks + loops the
  // fixer) + its fixer, and the PR-scoring merger.
  | 'spec-writer'
  | 'blueprints'
  | 'conflicts'
  | 'conflict-resolver'
  | 'ci'
  | 'ci-fixer'
  | 'merger'
  // Recurring tech-debt pipeline: read-only code `analysis`, then a special
  // non-LLM `tracker` step that files a GitHub issue / Jira ticket.
  | 'analysis'
  | 'tracker'

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
  /**
   * Per-step human approval gates, parallel to `agentKinds`: `gates[i]` true ⇒
   * the run pauses after step `i` for a human to review/edit its proposal. Absent
   * means no gates.
   */
  gates?: boolean[]
  /**
   * Per-step companion quality thresholds (0..1), parallel to `agentKinds`. Only
   * meaningful on companion steps; `null`/absent ⇒ use the companion's default bar.
   */
  thresholds?: (number | null)[]
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
  /** Bootstrap runs (the unified `agent_runs` bootstrap rows), so the board can
   * render a bootstrap's live progress / failure + retry on load. Absent on
   * older servers. */
  bootstrapJobs?: BootstrapJob[]
  /** Current spend-safeguard status; absent on older servers. */
  spend?: SpendStatus
  /** Open human-actionable notifications for the board inbox + badges. */
  notifications?: Notification[]
  /** The workspace's merge threshold presets (the task preset picker's options). */
  mergePresets?: MergeThresholdPreset[]
  /** Agent config-contribution descriptors (the task-level fields the board renders). */
  agentConfigCatalog?: AgentConfigDescriptor[]
  /** Per-agent-kind default model overrides for this workspace (agentKind → model id). */
  modelDefaults?: ModelDefaults
  /** The workspace's default service-fragment selection (ids new services inherit). */
  serviceFragmentDefaults?: ServiceFragmentDefaults
  /** The workspace's recurring pipelines (schedules shown on the board + inspector). */
  recurringPipelines?: PipelineSchedule[]
  /** The workspace's issue-tracker selection (where the tech-debt pipeline files tickets). */
  trackerSettings?: TrackerSettings
  /** In-org sharing: the services this workspace mounts (with per-board frame layout). */
  mounts?: WorkspaceMount[]
  /** In-org sharing: the org's services this board can mount from (with mount counts). */
  serviceCatalog?: Service[]
}

/**
 * A workspace's per-agent-kind default model choice. Keys are agent kinds, values
 * are model catalog ids (`ModelOption.id`). A kind absent from the map falls back
 * to the deployment's env-configured routing. Mirrors `@cat-factory/contracts`.
 */
export interface ModelDefaults {
  defaults: Record<string, string>
}

/**
 * A workspace's default service-fragment selection: the best-practice fragment ids
 * new services inherit onto their `serviceFragmentIds`. Mirrors `@cat-factory/contracts`.
 */
export interface ServiceFragmentDefaults {
  fragmentIds: string[]
}

/**
 * Real-time events pushed over the workspace WebSocket stream (see
 * `useWorkspaceStream`). Mirrors `WorkspaceEvent` in `@cat-factory/contracts`.
 */
export type WorkspaceEvent =
  | { type: 'execution'; instance: ExecutionInstance; block: Block | null; at: number }
  | { type: 'board'; reason: string; at: number }
  | { type: 'bootstrap'; job: BootstrapJob; block: Block | null; at: number }
  | { type: 'notification'; notification: Notification; at: number }

/** Level-of-detail buckets driven by the canvas zoom level. Shallow → deep:
 * `far`/`mid`/`close` govern a service frame (chip → card → opened with tasks);
 * `steps`/`subtasks` drill spatially into an individual task — revealing its
 * build-pipeline steps, then each step's live todo breakdown. */
export type LodLevel = 'far' | 'mid' | 'close' | 'steps' | 'subtasks'

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
export type * from './fragments'
export type * from './documents'
export type * from './tasks'
export type * from './bootstrap'
export type * from './github'
export type * from './accounts'
export type * from './notifications'
export type * from './slack'
export type * from './merge'
export type * from './services'
export type * from './recurring'
export type * from './tracker'
