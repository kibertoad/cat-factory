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

/** Live subtask counts a running step reports from the agent's own todo list. */
export interface StepSubtasks {
  completed: number
  inProgress: number
  total: number
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
  /** 'paused' = halted by the spend safeguard until the budget frees up. */
  status: 'running' | 'blocked' | 'done' | 'paused'
}
