// ---------------------------------------------------------------------------
// Execution model: a pipeline of agents running against a single block.
// Mirrors the `@cat-factory/contracts` execution schemas.
// ---------------------------------------------------------------------------

import type { AgentKind } from './domain'

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

/** One entry of a running step's todo list — its label and current status. */
export interface StepSubtaskItem {
  label: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** Live subtask counts a running step reports from the agent's own todo list. */
export interface StepSubtasks {
  completed: number
  inProgress: number
  total: number
  /** The individual todo entries, so a zoomed-in card can show the actual list. */
  items?: StepSubtaskItem[]
}

// ---------------------------------------------------------------------------
// Shared "agent run" failure model. Both flows that run an agent in a container
// — a task pipeline `execution` and a repo `bootstrap` — surface failures with
// this shape, so the board renders one failure banner + retry for either. Mirrors
// `agentFailureSchema` in `@cat-factory/contracts`.
// ---------------------------------------------------------------------------

/** The agent flows that produce a container-backed "agent run". */
export type AgentRunKind = 'bootstrap' | 'execution'

/** How an agent run faulted, so the board can classify it (and hint at a retry).
 * The union spans both flows; a given flow only ever produces a subset. */
export type AgentFailureKind =
  | 'preflight'
  | 'dispatch'
  | 'evicted'
  | 'timeout'
  | 'agent'
  | 'job_failed'
  | 'decision_timeout'
  | 'unknown'

/** Structured diagnostics captured when an agent run fails. */
export interface AgentFailure {
  kind: AgentFailureKind
  /** Human-readable summary (mirrors the run's one-line `error`). */
  message: string
  /** Extended detail when available (the harness's reason, an HTTP body, …). */
  detail: string | null
  /** Where to look next (e.g. "check the container logs for this job id"). */
  hint: string | null
  /** Epoch ms the failure was recorded. */
  occurredAt: number
  /** Last subtask counts seen before the failure, for context (null if none). */
  lastSubtasks: StepSubtasks | null
}

/** One agent's slot in a running pipeline. */
export interface PipelineStep {
  agentKind: AgentKind
  state: AgentState
  /** 0..1 progress of this individual step */
  progress: number
  /** live "N/M done" subtask counts while an async (container) step runs */
  subtasks?: StepSubtasks
  /** present + unresolved => the step (and block) is blocked */
  decision: Decision | null
  /** text the agent produced for this step (when LLM execution is enabled). */
  output?: string
  /** identifier of the model that produced `output`, for transparency. */
  model?: string
  /** prompt-fragment library ids folded into this step (manual ∪ selector pick). */
  selectedFragmentIds?: string[]
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
  /**
   * 'paused' = halted by the spend safeguard until the budget frees up;
   * 'failed' = the run faulted (see `failure`) — surfaces the shared failure
   * banner + retry, instead of the old success-looking `pr_ready` lie.
   */
  status: 'running' | 'blocked' | 'done' | 'paused' | 'failed'
  /** Structured failure diagnostics when `status` is `failed`; null otherwise. */
  failure?: AgentFailure | null
}
