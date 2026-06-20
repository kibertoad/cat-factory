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
  | 'rejected'
  | 'cancelled'
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

/**
 * One GitHub-review-style comment on a block of an agent's proposal (mirrors
 * `stepReviewCommentSchema` in contracts). `quotedSource` is the verbatim raw
 * markdown of the commented block, so a "request changes" re-run quotes the
 * agent's own text back to it.
 */
export interface ReviewComment {
  quotedSource: string
  /** 0-based source line range [start, end) of the commented block. */
  srcStart: number
  srcEnd: number
  body: string
}

/**
 * A human approval gate on a step (mirrors `stepApprovalSchema` in contracts).
 * Raised once a gated step's proposal is ready; the human reviews it in the
 * conclusions reader, then approves (advance), requests changes (re-run with
 * freeform feedback + per-block comments) or rejects (stop the run).
 */
export interface StepApproval {
  id: string
  status: 'pending' | 'approved' | 'changes_requested' | 'rejected'
  /** the agent's output the human reviews */
  proposal: string
  /** the human's freeform guidance when changes were requested */
  feedback?: string
  /** per-block review comments when changes were requested */
  comments?: ReviewComment[]
}

/**
 * LLM observability rollup for a step (mirrors `stepMetricsSchema` in contracts):
 * a compact aggregate over every model call the step's container made — token
 * usage, how close it ran to the output-token limit (truncation), the latency
 * split between transport/proxy overhead and actual model execution, and any
 * errors/warnings. Absent when the observability sink is not wired.
 */
export interface StepMetrics {
  calls: number
  promptTokens: number
  completionTokens: number
  /** the largest single completion produced (closest approach to the limit) */
  peakCompletionTokens: number
  /** the output ceiling in effect (max requested max_tokens), or null when unknown */
  maxOutputTokens: number | null
  /** calls cut short by the output limit (finish_reason === 'length') */
  truncatedCalls: number
  /** sum of model execution time (ms) — the actual prompt/tool execution */
  upstreamMs: number
  /** sum of transport/proxy overhead (ms) — the interim-layer cost */
  overheadMs: number
  /** calls that failed (non-2xx / refused / in-process error) */
  errors: number
  /** successful calls that warned (truncated or content-filtered) */
  warnings: number
}

/** One proxied LLM call's full detail (mirrors `llmCallMetricSchema` in contracts). */
export interface LlmCallMetric {
  id: string
  workspaceId: string
  executionId: string | null
  agentKind: string
  provider: string
  model: string
  createdAt: number
  streaming: boolean
  messageCount: number
  toolCount: number
  requestMaxTokens: number | null
  promptTokens: number
  /** prompt tokens served from the provider's prompt cache (subset of promptTokens) */
  cachedPromptTokens: number
  completionTokens: number
  totalTokens: number
  finishReason: string | null
  upstreamMs: number
  overheadMs: number
  totalMs: number
  ok: boolean
  httpStatus: number | null
  errorMessage: string | null
  /**
   * the request messages serialised as JSON, stored as a delta — only the messages
   * this call appended beyond `promptPrefixCount` (the full array when that is 0)
   */
  promptText: string
  /** leading messages elided from `promptText` (0 ⇒ it is the full array) */
  promptPrefixCount: number
  /** hash of the call's full messages array (chain key for the next call's delta) */
  promptHash: string
  /** the full assistant response text */
  responseText: string
}

/** One per-agent-kind insight in the LLM-friendly export (rollup + derived ratios). */
export interface LlmExportInsight extends StepMetrics {
  agentKind: string
  /** peakCompletionTokens / maxOutputTokens, 0..1; null when the ceiling is unknown. */
  outputHeadroomRatio: number | null
  /** overheadMs / (upstreamMs + overheadMs), 0..1; the share spent in transport. */
  transportOverheadRatio: number | null
}

/** LLM-friendly export of a run's model activity (mirrors `llmMetricsExportSchema`). */
export interface LlmMetricsExport {
  kind: 'cat-factory.llm-metrics-export'
  version: 1
  executionId: string
  generatedAt: number
  totals: {
    calls: number
    promptTokens: number
    completionTokens: number
    upstreamMs: number
    overheadMs: number
    transportOverheadRatio: number | null
    errors: number
    warnings: number
    truncatedCalls: number
  }
  insights: LlmExportInsight[]
  calls: LlmCallMetric[]
}

/** One agent's slot in a running pipeline. */
export interface PipelineStep {
  agentKind: AgentKind
  state: AgentState
  /** 0..1 progress of this individual step */
  progress: number
  /** LLM observability rollup for this step (token use, headroom, latency split). */
  metrics?: StepMetrics | null
  /** live "N/M done" subtask counts while an async (container) step runs */
  subtasks?: StepSubtasks
  /**
   * True while a container-backed step's per-run container is cold-booting (set at
   * dispatch, cleared once the container is up). Drives the "Spinning up container…"
   * phase indicator before any execution progress is available.
   */
  startingContainer?: boolean
  /** present + unresolved => the step (and block) is blocked */
  decision: Decision | null
  /** whether a human approval gate fires after this step (from the pipeline) */
  requiresApproval?: boolean
  /** the live approval gate for this step; pending => the run is blocked on a human */
  approval?: StepApproval | null
  /** text the agent produced for this step (when LLM execution is enabled). */
  output?: string
  /** identifier of the model that produced `output`, for transparency. */
  model?: string
  /** prompt-fragment library ids folded into this step (manual ∪ selector pick). */
  selectedFragmentIds?: string[]
  /** epoch ms the step first began executing (transitioned to `working`). */
  startedAt?: number | null
  /** epoch ms the step finished (transitioned to `done`); with `startedAt` gives duration. */
  finishedAt?: number | null
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
