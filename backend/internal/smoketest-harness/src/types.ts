import type { ModelCandidate } from '@cat-factory/benchmark-harness'

// Shared shapes for the smoketest harness. Unlike the benchmark harness it does
// NOT rate anything: it runs a real coding task through the actual Pi setup,
// captures the whole transcript, and the analyser turns the captured events into
// a list of findings + a coarse verdict. The point is to surface a model getting
// dead-ended, looping unproductively, or plainly broken — not to score quality.

export type { ModelCandidate }

/** A Pi `--mode json` event, as captured off the stream via `runPi`'s `onEvent`. */
export type PiEvent = Record<string, unknown>

/**
 * Coarse health of a single case run. Deliberately three buckets, not a score:
 * - `healthy`   — the agent ran the task through without a structural problem.
 * - `degraded`  — it finished, but with a warn-level smell (a loop, a sub-fatal
 *                 stall, no file changes) worth a human look.
 * - `broken`    — the model was unusable or the run hard-failed / was killed for
 *                 making no progress (an error-level finding).
 */
export type Verdict = 'healthy' | 'degraded' | 'broken'

export type FindingSeverity = 'info' | 'warn' | 'error'

/** What a finding is about — drives how the report groups and prioritises it. */
export type FindingCategory =
  /** The model could not be used at all / the run hard-failed. */
  | 'breakage'
  /** The agent stopped making progress (no edits, killed by the guard, gave up). */
  | 'dead-end'
  /** The agent repeated itself without advancing (loops, thrash, error retries). */
  | 'loop'

/** One observation about a run. The `code` is a stable id for grouping across runs. */
export interface Finding {
  /** Stable, machine-friendly id, e.g. `no-op-run`, `repeated-tool-call`. */
  code: string
  category: FindingCategory
  severity: FindingSeverity
  /** One-line, human-readable summary. */
  message: string
  /** Optional supporting detail (counts, the offending tool, the stderr tail…). */
  detail?: string
}

/** Quantitative summary of what the agent did, derived from the captured events. */
export interface CaseMetrics {
  /** Tool calls the agent made (`tool_execution_end` events). */
  toolCalls: number
  /** Of those, how many returned an error. */
  toolErrors: number
  /** File-mutating tool calls (best-effort, by tool name). */
  edits: number
  /** Total characters of assistant text produced. */
  assistantChars: number
  /** Parsed Pi events captured. */
  events: number
  /** Wall-clock duration of the Pi run. */
  durationMs: number
  /** Bytes of staged git diff the run produced (0 ⇒ no file changes). */
  diffBytes: number
  /** Files touched by the staged diff. */
  filesChanged: number
  /** Final state of the agent's todo list, if it used the tool. */
  todo?: { completed: number; inProgress: number; total: number }
  /** Token usage, if Pi reported it. */
  usage?: { inputTokens: number; outputTokens: number }
  /** Per-tool call counts, e.g. `{ bash: 12, read: 5, edit: 3 }`. */
  toolHistogram: Record<string, number>
}

/** The full result of running one case (one fixture × one model). */
export interface SmoketestCaseResult {
  /** Filesystem-safe id (also the artifact basename). */
  id: string
  fixtureId: string
  fixtureTitle: string
  /** Exact `provider:model` that produced the run. */
  model: string
  /** Friendly model label. */
  modelLabel: string
  /** The concrete task handed to the agent. */
  task: string
  verdict: Verdict
  findings: Finding[]
  metrics: CaseMetrics
  /** Pi's final assistant summary, if any. */
  summary?: string
  /** The run error (guard abort / terminal model error / spawn failure), if any. */
  error?: string
}

/** The analyser's output for one case (everything but identity + timing). */
export interface CaseAnalysis {
  verdict: Verdict
  findings: Finding[]
  metrics: CaseMetrics
  summary?: string
}
