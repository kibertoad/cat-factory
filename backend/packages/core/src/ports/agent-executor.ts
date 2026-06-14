import type { AgentKind, BlockType } from '../domain/types'

// Port for "an agent doing its work". The execution engine calls this to perform
// each pipeline step. An agent either produces a work product or asks for a
// human decision before it can finish. Concrete implementations:
//   - AiAgentExecutor         — real work via an LLM (Vercel AI SDK)
//   - SimulatorAgentExecutor  — the randomised, playful experience for local/mock runs
//   - a test fake             — deterministic, used by the integration tests
// Modelling the work as a port is what keeps the engine deterministic and free
// of both randomness and LLM concerns.

export interface AgentRunContext {
  agentKind: AgentKind
  pipelineName: string
  /** Index of this step within the pipeline. */
  stepIndex: number
  /** Whether this is the pipeline's last step (drives task finalisation). */
  isFinalStep: boolean
  block: {
    title: string
    type: BlockType
    description: string
    features?: string[]
    /** Ids of selected best-practice fragments to fold into the system prompt. */
    fragmentIds?: string[]
    /** Id of the model picked for this block (overrides the agent routing), if any. */
    modelId?: string
  }
  /** Outputs produced by earlier steps in the same run, in order. */
  priorOutputs: { agentKind: AgentKind; output: string }[]
  /** Decisions resolved earlier in this run, for context. */
  decisions: { question: string; chosen: string }[]
  /**
   * If this step previously raised a decision that a human has now resolved,
   * the resolved decision — so the agent can finish instead of re-raising it.
   */
  resolvedDecision: { question: string; chosen: string } | null
}

/** A point at which the agent needs a human to choose before continuing. */
export interface AgentDecisionRequest {
  question: string
  options: string[]
}

/** Token usage reported by the model for a single agent call. */
export interface AgentTokenUsage {
  inputTokens: number
  outputTokens: number
}

export interface AgentRunResult {
  /** The agent's work product. Required unless `decision` is set. */
  output?: string
  /** Identifier of the model that produced the output, for transparency. */
  model?: string
  /** Ask a human to decide before this step can complete. */
  decision?: AgentDecisionRequest
  /** Confidence in the result (0..1); used at task completion to auto-merge. */
  confidence?: number
  /**
   * Tokens the model consumed for this call. Reported by real LLM executors so
   * the spend safeguard can meter usage; absent for the simulator/stub, which
   * incur no real cost.
   */
  usage?: AgentTokenUsage
}

export interface AgentExecutor {
  run(context: AgentRunContext): Promise<AgentRunResult>
}
