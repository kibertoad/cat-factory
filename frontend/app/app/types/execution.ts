// ---------------------------------------------------------------------------
// Execution model: a pipeline of agents running against a single block.
//
// The wire shapes are sourced from @cat-factory/contracts (single source of
// truth) and re-exported here. A few names are aliased to the historical
// frontend names, and the handful with no exported contract equivalent (the
// agent-context snapshot view, the inline companion-state shape) are kept
// frontend-only below.
// ---------------------------------------------------------------------------

export type {
  CompanionVerdict,
  IterationCapChoice,
  AgentState,
  Decision,
  StepSubtaskItem,
  StepSubtasks,
  AgentRunKind,
  AgentFailureKind,
  AgentFailure,
  PriorStepOutput,
  StepApproval,
  StepMetrics,
  LlmCallMetric,
  LlmCallActivity,
  LlmExportInsight,
  LlmMetricsExport,
  AgentSearchQuery,
  WebSearchAvailability,
  WebSearchProvider,
  PipelineStep,
  FollowUpItemKind,
  FollowUpItemStatus,
  FollowUpItem,
  FollowUpsStepState,
  ForkOption,
  ForkChatMessage,
  ForkDecisionStatus,
  ForkChoice,
  ForkDecisionStepState,
  PrReviewStepState,
  PrReviewFinding,
  PrReviewSlice,
  PrReviewSeverity,
  PrReviewCategory,
  GateFailingCheck,
  GateAttempt,
  GateStepState,
  TesterStepState,
  HumanTestEnvironment,
  RunEnvironment,
  RunContainer,
  RunContainerStatus,
  HumanTestRound,
  HumanTestStepState,
  VisualConfirmStepState,
  VisualConfirmPair,
  VisualConfirmRound,
  ExecutionInstance,
  // The historical frontend name for a per-block review comment is the contract's
  // StepReviewComment; the env-status union is the contract's EnvironmentStatus.
  StepReviewComment as ReviewComment,
  EnvironmentStatus as HumanTestEnvironmentStatus,
} from '@cat-factory/contracts'

import type { CompanionVerdict } from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// Frontend-only shapes with no exported contract type. The contract defines them
// inline (anonymous) on their parent schemas, so they are re-stated here for the
// few components/stores that reference them directly.
// ---------------------------------------------------------------------------

/** Live companion state on a companion step: the bar, the budget, and every verdict. */
export interface StepCompanion {
  /** the quality bar (0..1) the latest verdict's rating must reach */
  threshold: number
  /** the automatic rework budget: once `attempts` reaches this the gate parks for a human */
  maxAttempts: number
  /** how many AUTOMATIC reworks have run (human "request changes" cycles don't count) */
  attempts?: number
  /** one verdict per correction cycle, in order; the last is the latest */
  verdicts: CompanionVerdict[]
  /**
   * Set once the automatic rework budget is spent with the rating still below the bar:
   * the step parks on its approval gate for a human to resolve via the iteration-cap
   * prompt (one more round / proceed / stop & reset). Cleared on an extra round.
   */
  exceeded?: boolean
}

/** One best-practice fragment folded into an agent's system prompt. */
export interface AgentContextFragment {
  id: string
  body: string
}

/** One file injected into the agent's container as context, with its full body. */
export interface AgentContextFile {
  path: string
  title: string
  url: string
  content: string
}

/**
 * The complete, redacted context provided to one container-agent dispatch: the composed
 * system + user prompts, the fragment bodies folded in, and the full content of the files
 * injected into the container. Loaded on demand for the observability view. Mirrors the
 * backend `AgentContextSnapshot` (it never carries any credential).
 */
export interface AgentContextSnapshot {
  id: string
  workspaceId: string
  executionId: string
  agentKind: string
  stepIndex: number
  createdAt: number
  model: string | null
  harness: string | null
  systemPrompt: string
  userPrompt: string
  fragments: AgentContextFragment[]
  contextFiles: AgentContextFile[]
  extras: Record<string, unknown>
}
