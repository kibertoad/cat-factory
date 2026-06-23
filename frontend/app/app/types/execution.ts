// ---------------------------------------------------------------------------
// Execution model: a pipeline of agents running against a single block.
// Mirrors the `@cat-factory/contracts` execution schemas.
// ---------------------------------------------------------------------------

import type { AgentKind, TestReport } from './domain'

/**
 * A quality companion's verdict on one producer output — the standardized shape every
 * pipeline companion step stores, one per rework cycle.
 */
export interface CompanionVerdict {
  /** Overall quality rating of the graded output (0..1, higher = better). */
  rating: number
  /** The quality bar the rating had to reach to pass. */
  threshold: number
  /** Whether the rating met the threshold. */
  passed: boolean
  /** The companion's challenge, shown to the human and fed into the next rework. */
  feedback: string
}

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

/**
 * How a human resolves an iterative agent gate that hit its budget — shared by the
 * requirements reviewer and the quality companions. Mirror of the backend's
 * `IterationCapChoice` (see `@cat-factory/contracts` iteration-cap.ts).
 */
export type IterationCapChoice = 'extra-round' | 'proceed' | 'stop-reset'

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

/**
 * The compact per-call summary pushed live over the workspace stream (the `llmCall`
 * event). It is {@link LlmCallMetric} WITHOUT the heavy text bodies and delta
 * bookkeeping, so an open "Model activity" panel updates in real time without
 * shipping prompt bytes. The panel lazy-loads the full bodies for an expanded row
 * from the persisted metrics endpoint, keyed by the shared `id`. Mirrors
 * `LlmCallActivity` in `@cat-factory/contracts`.
 */
export type LlmCallActivity = Omit<
  LlmCallMetric,
  'promptText' | 'responseText' | 'promptPrefixCount' | 'promptHash'
>

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
  /**
   * Live companion state when this step is a companion kind: its quality bar, rework
   * budget, and the full sequence of verdicts (one per correction cycle). Absent on
   * non-companion steps.
   */
  companion?: StepCompanion | null
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
  /**
   * Live Tester→Fixer loop state when this step is a `tester` kind: which phase is in
   * flight (testing vs fixing the issues it found), the fixer attempt budget, and the
   * latest structured test report. Absent on non-tester steps.
   */
  test?: TesterStepState | null
  /**
   * Live gate state when this step is a polling gate (`ci` / `conflicts`): which phase
   * is in flight (checking the precheck vs a helper working), the helper attempt
   * budget, the gated commit, and the latest precheck verdict + failure detail. Absent
   * on non-gate steps. Mirrors `gateStepStateSchema`.
   */
  gate?: GateStepState | null
}

/** One failing CI check the gate's precheck saw (mirrors `gateFailingCheckSchema`). */
export interface GateFailingCheck {
  name: string
  conclusion: string | null
}

/** Live state of a polling gate step (`ci` / `conflicts`); mirrors `gateStepStateSchema`. */
export interface GateStepState {
  phase: 'checking' | 'working'
  /** how many helper-agent attempts have been dispatched so far */
  attempts: number
  /** ceiling on helper attempts (from the task's merge preset) */
  maxAttempts: number
  /** the PR head commit being gated, once resolved */
  headSha?: string | null
  /** the most recent precheck verdict (why the gate is looping vs idle-passing) */
  lastVerdict?: 'pass' | 'pending' | 'fail' | null
  /** human-readable summary of the latest failing precheck (failing checks / conflict reason) */
  lastFailureSummary?: string | null
  /** structured failing checks behind the summary (CI gate only; absent for conflicts) */
  failingChecks?: GateFailingCheck[] | null
}

/** Live state of a `tester` step's Tester→Fixer loop (mirrors `testerStepStateSchema`). */
export interface TesterStepState {
  phase: 'testing' | 'fixing'
  /** how many fixer attempts have been dispatched so far */
  attempts: number
  /** ceiling on fixer attempts (from the task's merge preset) */
  maxAttempts: number
  /** the most recent Tester report (what was tested, outcomes, concerns, greenlight) */
  lastReport?: TestReport | null
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
