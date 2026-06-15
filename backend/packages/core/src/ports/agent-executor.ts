import type {
  AgentKind,
  BlockType,
  EnvironmentAccessHandle,
  EnvironmentStatus,
  PullRequestRef,
  TestTarget,
} from '../domain/types'

// Port for "an agent doing its work". The execution engine calls this to perform
// each pipeline step. An agent either produces a work product or asks for a
// human decision before it can finish. Concrete implementations:
//   - AiAgentExecutor         — real work via an LLM (Vercel AI SDK)
//   - ContainerAgentExecutor  — repo-operating steps in a per-run sandbox container
//   - a test fake             — deterministic, used by the integration tests
// Modelling the work as a port keeps the engine free of LLM/infra concerns and
// lets the integration tests drive it with a deterministic fake.

export interface AgentRunContext {
  agentKind: AgentKind
  pipelineName: string
  /**
   * The workspace and execution the step belongs to. The engine always sets
   * these; they are optional on the type so existing fakes that hand-build a
   * context stay valid. Executors that reach beyond the LLM — e.g. the container
   * executor that clones the workspace's repo and meters spend through a proxy —
   * require them and fail fast when absent.
   */
  workspaceId?: string
  executionId?: string
  /** Index of this step within the pipeline. */
  stepIndex: number
  /** Whether this is the pipeline's last step (drives task finalisation). */
  isFinalStep: boolean
  block: {
    /** Stable block id (set by the engine; used by repo-aware executors). */
    id?: string
    title: string
    type: BlockType
    description: string
    features?: string[]
    /** Ids of selected best-practice fragments to fold into the system prompt. */
    fragmentIds?: string[]
    /** Id of the model picked for this block (overrides the agent routing), if any. */
    modelId?: string
    /**
     * Requirements/RFC/PRD pages linked to this block from Confluence, supplied
     * as extra context. Present only when the Confluence integration is wired and
     * the block has linked documents.
     */
    contextDocs?: { title: string; url: string; excerpt: string }[]
    /**
     * Where this block's acceptance / Playwright tests should run. Folded into
     * the acceptance-testing agents' prompt so generated tests target the right
     * harness. Absent when no preference is recorded.
     */
    testTarget?: TestTarget
  }
  /** Outputs produced by earlier steps in the same run, in order. */
  priorOutputs: { agentKind: AgentKind; output: string }[]
  /** Decisions resolved earlier in this run, for context. */
  decisions: { question: string; chosen: string }[]
  /**
   * A live ephemeral environment a deployer step provisioned earlier in this run
   * (resolved from the run's block). Present only when the environment
   * integration is wired and a deployer step has produced a ready environment —
   * this is how a downstream tester agent discovers the URL and how to reach it.
   */
  environment?: {
    url: string | null
    status: EnvironmentStatus
    access: EnvironmentAccessHandle | null
    expiresAt: number | null
  }
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
   * A pull request the agent opened for its work. Reported by repo-operating
   * executors (the container "implementer" agent, which pushes a branch and opens
   * a PR); the engine records it on the block so the board can link to it.
   */
  pullRequest?: PullRequestRef
  /**
   * Tokens the model consumed for this call. Reported by inline LLM executors so
   * the spend safeguard can meter usage; absent for the container executor (whose
   * proxy meters tokens itself, to avoid double-counting) and test fakes.
   */
  usage?: AgentTokenUsage
}

export interface AgentExecutor {
  run(context: AgentRunContext): Promise<AgentRunResult>
}
